'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');

// ============================================================
// Files
// ============================================================

const BASE_DIR = __dirname;
const CONFIG_FILE = path.join(BASE_DIR, 'config.json');
const PROXIES_FILE = path.join(BASE_DIR, 'proxies.txt');
const STATE_FILE = path.join(BASE_DIR, 'state.json');

// ============================================================
// Load config
// ============================================================

function loadJson(file, fallback = null) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        if (fallback !== null) {
            return fallback;
        }

        console.error(`Failed to load ${file}:`, err.message);
        process.exit(1);
    }
}

const config = loadJson(CONFIG_FILE);

const LISTEN_HOST = config.listen.host || '0.0.0.0';
const LISTEN_PORT = Number(config.listen.port || 8080);

const QUOTA = Number(
    config.quota?.bytes_per_account || 100_000_000
);

const HEALTH_INTERVAL = Number(
    config.health_check?.interval_ms || 30_000
);

const HEALTH_TIMEOUT = Number(
    config.health_check?.timeout_ms || 5_000
);

const FAILURE_COOLDOWN = Number(
    config.health_check?.failure_cooldown_ms || 60_000
);

const CONNECT_TIMEOUT = Number(
    config.upstream?.connect_timeout_ms || 15_000
);

const MAX_HEADER = Number(
    config.server?.max_header_bytes || 64 * 1024
);

const RETRY_UPSTREAM = config.upstream?.retry_on_connect_failure !== false;

const CLIENT_AUTH_ENABLED =
    config.auth?.enabled !== false;

const CLIENT_USERNAME =
    String(config.auth?.username || '');

const CLIENT_PASSWORD =
    String(config.auth?.password || '');

const WHITELIST_ENABLED =
    config.ip_whitelist?.enabled === true;

const WHITELIST = new Set(
    Array.isArray(config.ip_whitelist?.ips)
        ? config.ip_whitelist.ips.map(normalizeIp)
        : []
);

// ============================================================
// Validation
// ============================================================

if (!Number.isSafeInteger(QUOTA) || QUOTA <= 0) {
    console.error('Invalid quota.bytes_per_account');
    process.exit(1);
}

if (CLIENT_AUTH_ENABLED &&
    (!CLIENT_USERNAME || !CLIENT_PASSWORD)) {
    console.error(
        'auth.enabled=true but username/password are missing'
    );
    process.exit(1);
}

// ============================================================
// Proxy accounts
// Format:
// HOST:PORT:USERNAME:PASSWORD
//
// Password may contain ":".
// ============================================================

function loadProxies() {
    if (!fs.existsSync(PROXIES_FILE)) {
        console.error(`Missing ${PROXIES_FILE}`);
        process.exit(1);
    }

    const lines = fs.readFileSync(PROXIES_FILE, 'utf8')
        .split(/\r?\n/)
        .map(x => x.trim())
        .filter(x => x && !x.startsWith('#'));

    const accounts = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        const parts = line.split(':');

        if (parts.length < 4) {
            console.error(
                `Invalid proxies.txt line ${i + 1}: ${line}`
            );
            process.exit(1);
        }

        const host = parts.shift();
        const port = Number(parts.shift());
        const username = parts.shift();
        const password = parts.join(':');

        if (!host || !Number.isInteger(port) ||
            port <= 0 || port > 65535 ||
            !username || !password) {
            console.error(
                `Invalid proxies.txt line ${i + 1}: ${line}`
            );
            process.exit(1);
        }

        accounts.push({
            host,
            port,
            username,
            password
        });
    }

    if (accounts.length === 0) {
        console.error('No upstream proxy accounts found.');
        process.exit(1);
    }

    return accounts;
}

const accounts = loadProxies();

// ============================================================
// Persistent state
//
// IMPORTANT:
// Only "used" is persisted.
// There is NO "reserved" field.
// ============================================================

function createInitialState() {
    return {
        current: 0,
        accounts: accounts.map(() => ({
            used: 0
        }))
    };
}

function loadState() {
    if (!fs.existsSync(STATE_FILE)) {
        return createInitialState();
    }

    try {
        const parsed = JSON.parse(
            fs.readFileSync(STATE_FILE, 'utf8')
        );

        if (!parsed || !Array.isArray(parsed.accounts)) {
            throw new Error('Invalid state structure');
        }

        const state = {
            current: Number.isInteger(parsed.current)
                ? parsed.current
                : 0,

            accounts: accounts.map((_, i) => {
                const old = parsed.accounts[i];

                const used =
                    old && Number.isSafeInteger(old.used)
                        ? old.used
                        : 0;

                return {
                    used: Math.max(0, Math.min(used, QUOTA))
                };
            })
        };

        if (state.current < 0 ||
            state.current >= accounts.length) {
            state.current = 0;
        }

        return state;
    } catch (err) {
        console.error(
            `Failed to load state.json: ${err.message}`
        );

        process.exit(1);
    }
}

const state = loadState();

// ============================================================
// State persistence
// ============================================================

let saveTimer = null;

function saveStateSoon() {
    if (saveTimer) {
        return;
    }

    saveTimer = setTimeout(() => {
        saveTimer = null;

        try {
            const tmp = `${STATE_FILE}.tmp`;

            fs.writeFileSync(
                tmp,
                JSON.stringify(state, null, 2),
                'utf8'
            );

            fs.renameSync(tmp, STATE_FILE);
        } catch (err) {
            console.error(
                'Failed to save state.json:',
                err.message
            );
        }
    }, 50);
}

function saveStateNow() {
    try {
        const tmp = `${STATE_FILE}.tmp`;

        fs.writeFileSync(
            tmp,
            JSON.stringify(state, null, 2),
            'utf8'
        );

        fs.renameSync(tmp, STATE_FILE);
    } catch (err) {
        console.error(
            'Failed to save state.json:',
            err.message
        );
    }
}

// ============================================================
// Health state
// ============================================================

const health = accounts.map(() => ({
    healthy: true,
    checking: false,
    failUntil: 0,
    lastCheck: 0,
    lastError: null
}));

// ============================================================
// IP helpers
// ============================================================

function normalizeIp(ip) {
    if (!ip) {
        return '';
    }

    ip = String(ip).trim();

    // Node often reports IPv4 as ::ffff:1.2.3.4
    if (ip.startsWith('::ffff:')) {
        return ip.substring(7);
    }

    if (ip === '::1') {
        return '127.0.0.1';
    }

    return ip;
}

function getClientIp(socket) {
    return normalizeIp(socket.remoteAddress);
}

function ipAllowed(socket) {
    if (!WHITELIST_ENABLED) {
        return true;
    }

    return WHITELIST.has(getClientIp(socket));
}

// ============================================================
// Client authentication
// ============================================================

function unauthorizedResponse() {
    return [
        'HTTP/1.1 407 Proxy Authentication Required',
        'Proxy-Authenticate: Basic realm="Relay"',
        'Connection: close',
        'Content-Length: 0',
        '',
        ''
    ].join('\r\n');
}

function forbiddenResponse() {
    return [
        'HTTP/1.1 403 Forbidden',
        'Connection: close',
        'Content-Length: 0',
        '',
        ''
    ].join('\r\n');
}

function serverBusyResponse() {
    return [
        'HTTP/1.1 503 Service Unavailable',
        'Connection: close',
        'Content-Length: 0',
        '',
        ''
    ].join('\r\n');
}

function checkClientAuth(headers) {
    if (!CLIENT_AUTH_ENABLED) {
        return true;
    }

    const value = headers['proxy-authorization'];

    if (!value) {
        return false;
    }

    const match = /^Basic\s+(.+)$/i.exec(value);

    if (!match) {
        return false;
    }

    let decoded;

    try {
        decoded = Buffer.from(
            match[1],
            'base64'
        ).toString('utf8');
    } catch {
        return false;
    }

    const separator = decoded.indexOf(':');

    if (separator < 0) {
        return false;
    }

    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);

    return (
        username === CLIENT_USERNAME &&
        password === CLIENT_PASSWORD
    );
}

// ============================================================
// HTTP header parser
// ============================================================

function parseHeaders(buffer) {
    const end = buffer.indexOf('\r\n\r\n');

    if (end === -1) {
        return null;
    }

    if (end + 4 > MAX_HEADER) {
        throw new Error('Header too large');
    }

    const head = buffer
        .subarray(0, end)
        .toString('latin1');

    const lines = head.split('\r\n');

    if (lines.length === 0) {
        throw new Error('Invalid request');
    }

    const requestLine = lines.shift();

    const firstSpace = requestLine.indexOf(' ');
    const secondSpace =
        requestLine.indexOf(' ', firstSpace + 1);

    if (firstSpace <= 0 || secondSpace <= firstSpace) {
        throw new Error('Invalid request line');
    }

    const method =
        requestLine.slice(0, firstSpace);

    const target =
        requestLine.slice(
            firstSpace + 1,
            secondSpace
        );

    const version =
        requestLine.slice(secondSpace + 1);

    const headers = {};

    for (const line of lines) {
        const idx = line.indexOf(':');

        if (idx <= 0) {
            continue;
        }

        const name =
            line.slice(0, idx)
                .trim()
                .toLowerCase();

        const value =
            line.slice(idx + 1).trim();

        headers[name] = value;
    }

    return {
        method,
        target,
        version,
        headers,
        headerBytes: end + 4
    };
}

// ============================================================
// Quota allocation
//
// CRITICAL:
// This function contains no await.
// The check and increment are performed synchronously.
//
// There is no reserved counter.
// ============================================================

function allocateBytes(accountIndex, requested) {
    if (!Number.isSafeInteger(requested) ||
        requested <= 0) {
        return 0;
    }

    const account = state.accounts[accountIndex];

    if (!account) {
        return 0;
    }

    const available = QUOTA - account.used;

    if (available <= 0) {
        return 0;
    }

    const allowed = Math.min(
        requested,
        available
    );

    // Atomic from the application's event-loop perspective.
    account.used += allowed;

    if (account.used > QUOTA) {
        account.used = QUOTA;
    }

    saveStateSoon();

    return allowed;
}

// ============================================================
// Account selection
//
// An account is selected only when:
// used < quota
// and it is healthy.
// ============================================================

function findNextAccount() {
    const total = accounts.length;

    for (let offset = 0; offset < total; offset++) {
        const index =
            (state.current + offset) % total;

        const accountState = state.accounts[index];

        if (accountState.used >= QUOTA) {
            continue;
        }

        const h = health[index];

        if (!h.healthy &&
            Date.now() < h.failUntil) {
            continue;
        }

        return index;
    }

    return -1;
}

function advanceCurrentIfNeeded() {
    const total = accounts.length;

    for (let offset = 0; offset < total; offset++) {
        const index =
            (state.current + offset) % total;

        if (state.accounts[index].used < QUOTA &&
            (
                health[index].healthy ||
                Date.now() >= health[index].failUntil
            )) {
            state.current = index;
            return;
        }
    }

    // All currently unavailable/full.
    state.current =
        (state.current + 1) % total;
}

// ============================================================
// Upstream connection
// ============================================================

function connectUpstream(accountIndex) {
    return new Promise((resolve, reject) => {
        const account = accounts[accountIndex];

        const socket = net.createConnection({
            host: account.host,
            port: account.port
        });

        let settled = false;

        const timer = setTimeout(() => {
            socket.destroy();

            if (!settled) {
                settled = true;
                reject(
                    new Error('upstream connect timeout')
                );
            }
        }, CONNECT_TIMEOUT);

        socket.once('connect', () => {
            clearTimeout(timer);

            if (!settled) {
                settled = true;
                resolve(socket);
            }
        });

        socket.once('error', err => {
            clearTimeout(timer);

            if (!settled) {
                settled = true;
                reject(err);
            }
        });
    });
}

// ============================================================
// Upstream proxy authentication
// ============================================================

function upstreamAuth(account) {
    return Buffer.from(
        `${account.username}:${account.password}`
    ).toString('base64');
}

// ============================================================
// Send quota-metered data
//
// Returns:
//   true  = all bytes were allowed
//   false = quota reached and connection should hard-cut
// ============================================================

function writeMetered(
    socket,
    accountIndex,
    data,
    onQuota
) {
    if (!data || data.length === 0) {
        return true;
    }

    const allowed =
        allocateBytes(
            accountIndex,
            data.length
        );

    if (allowed <= 0) {
        onQuota();
        return false;
    }

    const part =
        allowed === data.length
            ? data
            : data.subarray(0, allowed);

    const ok = socket.write(part);

    if (allowed < data.length) {
        onQuota();
        return false;
    }

    // write() returning false means backpressure,
    // not failure. Node will emit drain later.
    void ok;

    return true;
}

// ============================================================
// Hard-cut helper
// ============================================================

function hardCut(client, upstream) {
    try {
        client.destroy();
    } catch {}

    try {
        upstream.destroy();
    } catch {}
}

// ============================================================
// HTTPS CONNECT
// ============================================================

async function handleConnect(
    client,
    parsed,
    initialBuffer
) {
    const target = parsed.target;

    const match =
        /^([^:]+):(\d+)$/.exec(target);

    if (!match) {
        client.end(
            'HTTP/1.1 400 Bad Request\r\n' +
            'Connection: close\r\n' +
            'Content-Length: 0\r\n\r\n'
        );
        return;
    }

    const host = match[1];
    const port = Number(match[2]);

    if (!Number.isInteger(port) ||
        port < 1 ||
        port > 65535) {
        client.end(
            'HTTP/1.1 400 Bad Request\r\n' +
            'Connection: close\r\n' +
            'Content-Length: 0\r\n\r\n'
        );
        return;
    }

    let accountIndex = -1;
    let upstream = null;

    // Retry different healthy accounts before CONNECT succeeds.
    const attempts = accounts.length;

    for (let n = 0; n < attempts; n++) {
        const index = findNextAccount();

        if (index < 0) {
            break;
        }

        // Avoid repeatedly selecting the same failed account
        // in this connection.
        state.current = index;

        try {
            upstream =
                await connectUpstream(index);

            accountIndex = index;
            break;
        } catch (err) {
            markFailure(index, err);
            state.current =
                (index + 1) % accounts.length;
        }
    }

    if (!upstream || accountIndex < 0) {
        client.end(serverBusyResponse());
        return;
    }

    const account = accounts[accountIndex];

    const connectRequest =
        `CONNECT ${host}:${port} HTTP/1.1\r\n` +
        `Host: ${host}:${port}\r\n` +
        `Proxy-Authorization: Basic ${upstreamAuth(account)}\r\n` +
        `Connection: keep-alive\r\n` +
        `\r\n`;

    let upstreamHeader = Buffer.alloc(0);
    let connected = false;
    let closed = false;

    const cleanup = () => {
        if (closed) {
            return;
        }

        closed = true;

        client.removeAllListeners('data');
        upstream.removeAllListeners('data');

        try {
            upstream.destroy();
        } catch {}

        try {
            client.destroy();
        } catch {}
    };

    client.on('error', cleanup);
    upstream.on('error', cleanup);

    upstream.on('data', chunk => {
        if (closed) {
            return;
        }

        if (!connected) {
            upstreamHeader =
                Buffer.concat([
                    upstreamHeader,
                    chunk
                ]);

            const end =
                upstreamHeader.indexOf(
                    '\r\n\r\n'
                );

            if (end === -1) {
                if (
                    upstreamHeader.length >
                    MAX_HEADER
                ) {
                    cleanup();
                }

                return;
            }

            const header =
                upstreamHeader
                    .subarray(0, end + 4)
                    .toString('latin1');

            if (!/^HTTP\/1\.[01]\s+200\b/i.test(header)) {
                client.end(header);
                cleanup();
                return;
            }

            connected = true;

            client.write(
                upstreamHeader
                    .subarray(0, end + 4)
            );

            const rest =
                upstreamHeader.subarray(end + 4);

            upstreamHeader = Buffer.alloc(0);

            if (rest.length > 0) {
                const ok = writeMetered(
                    client,
                    accountIndex,
                    rest,
                    () => hardCut(
                        client,
                        upstream
                    )
                );

                if (!ok) {
                    return;
                }
            }

            // From now on, tunnel mode.
            upstream.on('data', () => {});
            return;
        }

        writeMetered(
            client,
            accountIndex,
            chunk,
            () => hardCut(
                client,
                upstream
            )
        );
    });

    upstream.write(connectRequest);

    // Anything after CONNECT headers is already TLS/data
    // from the client and must be forwarded.
    const remaining =
        initialBuffer.subarray(
            parsed.headerBytes
        );

    if (remaining.length > 0) {
        const ok = writeMetered(
            upstream,
            accountIndex,
            remaining,
            () => hardCut(
                client,
                upstream
            )
        );

        if (!ok) {
            return;
        }
    }

    client.on('data', chunk => {
        if (!connected || closed) {
            return;
        }

        writeMetered(
            upstream,
            accountIndex,
            chunk,
            () => hardCut(
                client,
                upstream
            )
        );
    });

    client.on('end', () => {
        try {
            upstream.end();
        } catch {}
    });

    upstream.on('end', () => {
        try {
            client.end();
        } catch {}
    });

    upstream.on('close', () => {
        if (!client.destroyed) {
            client.destroy();
        }
    });

    client.on('close', () => {
        if (!upstream.destroyed) {
            upstream.destroy();
        }
    });
}

// ============================================================
// Normal HTTP proxy
// ============================================================

async function handleHttp(
    client,
    parsed,
    initialBuffer
) {
    let accountIndex = -1;
    let upstream = null;

    const attempts = accounts.length;

    for (let n = 0; n < attempts; n++) {
        const index = findNextAccount();

        if (index < 0) {
            break;
        }

        state.current = index;

        try {
            upstream =
                await connectUpstream(index);

            accountIndex = index;
            break;
        } catch (err) {
            markFailure(index, err);

            state.current =
                (index + 1) % accounts.length;
        }
    }

    if (!upstream || accountIndex < 0) {
        client.end(serverBusyResponse());
        return;
    }

    const account = accounts[accountIndex];

    // Rebuild request.
    //
    // For absolute-form requests:
    //   GET http://example.com/a HTTP/1.1
    //
    // This is valid for an HTTP proxy.
    //
    // We remove client's Proxy-Authorization and
    // replace it with the Vital upstream credentials.

    const lines = [];

    lines.push(
        `${parsed.method} ${parsed.target} ${parsed.version}`
    );

    for (const [name, value] of Object.entries(parsed.headers)) {
        if (name === 'proxy-authorization') {
            continue;
        }

        // Avoid forwarding hop-by-hop proxy connection headers.
        if (name === 'proxy-connection') {
            continue;
        }

        lines.push(`${name}: ${value}`);
    }

    lines.push(
        `Proxy-Authorization: Basic ${upstreamAuth(account)}`
    );

    lines.push('');
    lines.push('');

    const rebuilt =
        Buffer.from(
            lines.join('\r\n'),
            'latin1'
        );

    let closed = false;

    const cleanup = () => {
        if (closed) {
            return;
        }

        closed = true;

        try {
            client.destroy();
        } catch {}

        try {
            upstream.destroy();
        } catch {}
    };

    client.on('error', cleanup);
    upstream.on('error', cleanup);

    // Meter the rewritten request bytes sent to Vital.
    const headerOk = writeMetered(
        upstream,
        accountIndex,
        rebuilt,
        cleanup
    );

    if (!headerOk) {
        return;
    }

    // Forward bytes already received after HTTP headers.
    const remaining =
        initialBuffer.subarray(
            parsed.headerBytes
        );

    if (remaining.length > 0) {
        const bodyOk = writeMetered(
            upstream,
            accountIndex,
            remaining,
            cleanup
        );

        if (!bodyOk) {
            return;
        }
    }

    client.on('data', chunk => {
        if (closed) {
            return;
        }

        writeMetered(
            upstream,
            accountIndex,
            chunk,
            cleanup
        );
    });

    upstream.on('data', chunk => {
        if (closed) {
            return;
        }

        writeMetered(
            client,
            accountIndex,
            chunk,
            cleanup
        );
    });

    client.on('end', () => {
        try {
            upstream.end();
        } catch {}
    });

    upstream.on('end', () => {
        try {
            client.end();
        } catch {}
    });

    client.on('close', () => {
        if (!upstream.destroyed) {
            upstream.destroy();
        }
    });

    upstream.on('close', () => {
        if (!client.destroyed) {
            client.destroy();
        }
    });
}

// ============================================================
// Health check
//
// This checks whether the Vital proxy endpoint can accept
// a TCP connection.
//
// It does NOT consume relay quota.
// It does NOT modify account.used.
// ============================================================

async function healthCheck(index) {
    const h = health[index];

    if (h.checking) {
        return;
    }

    h.checking = true;
    h.lastCheck = Date.now();

    try {
        const socket =
            await connectUpstream(index);

        socket.destroy();

        h.healthy = true;
        h.failUntil = 0;
        h.lastError = null;
    } catch (err) {
        h.healthy = false;
        h.failUntil =
            Date.now() + FAILURE_COOLDOWN;

        h.lastError = err.message;
    } finally {
        h.checking = false;
    }
}

function markFailure(index, err) {
    const h = health[index];

    h.healthy = false;
    h.failUntil =
        Date.now() + FAILURE_COOLDOWN;

    h.lastError =
        err?.message || 'upstream failure';
}

// ============================================================
// Periodic health checks
// ============================================================

async function runHealthChecks() {
    for (let i = 0; i < accounts.length; i++) {
        healthCheck(i).catch(() => {});
    }
}

setInterval(
    runHealthChecks,
    HEALTH_INTERVAL
).unref();

runHealthChecks();

// ============================================================
// Client connection handling
// ============================================================

const server = net.createServer({
    pauseOnConnect: true
}, client => {
    const clientIp = getClientIp(client);

    console.log(
        `[CLIENT] ${clientIp} connected`
    );

    if (!ipAllowed(client)) {
        console.warn(
            `[AUTH] IP denied: ${clientIp}`
        );

        client.end(forbiddenResponse());
        return;
    }

    let buffer = Buffer.alloc(0);
    let parsed = null;
    let handled = false;

    const timeout = setTimeout(() => {
        if (!handled) {
            client.destroy();
        }
    }, 15_000);

    client.on('error', err => {
        if (!handled) {
            console.warn(
                `[CLIENT] ${clientIp}: ${err.message}`
            );
        }
    });

    const onData = chunk => {
        if (handled) {
            return;
        }

        buffer =
            Buffer.concat([
                buffer,
                chunk
            ]);

        if (buffer.length > MAX_HEADER) {
            clearTimeout(timeout);
            client.destroy();
            return;
        }

        let result;

        try {
            result = parseHeaders(buffer);
        } catch (err) {
            clearTimeout(timeout);
            client.destroy();
            return;
        }

        if (!result) {
            return;
        }

        parsed = result;
        handled = true;

        clearTimeout(timeout);

        client.removeListener(
            'data',
            onData
        );

        // Authentication happens before connecting upstream.
        if (!checkClientAuth(parsed.headers)) {
            client.end(unauthorizedResponse());
            return;
        }

        // Keep socket paused until handlers are ready.
        if (
            parsed.method.toUpperCase() === 'CONNECT'
        ) {
            handleConnect(
                client,
                parsed,
                buffer
            ).catch(err => {
                console.error(
                    '[CONNECT] handler error:',
                    err.message
                );

                try {
                    client.destroy();
                } catch {}
            });
        } else {
            handleHttp(
                client,
                parsed,
                buffer
            ).catch(err => {
                console.error(
                    '[HTTP] handler error:',
                    err.message
                );

                try {
                    client.destroy();
                } catch {}
            });
        }

        client.resume();
    };

    client.on('data', onData);

    client.resume();
});

// ============================================================
// Server tuning
// ============================================================

server.maxConnections =
    Number(config.server?.max_connections || 0) || undefined;

server.on('error', err => {
    console.error(
        '[SERVER]',
        err.message
    );
});

server.listen(
    LISTEN_PORT,
    LISTEN_HOST,
    () => {
        console.log('');
        console.log('======================================');
        console.log(' Vital Data Hard-Cut Relay');
        console.log('======================================');
        console.log(
            `Listen: ${LISTEN_HOST}:${LISTEN_PORT}`
        );
        console.log(
            `Quota: ${QUOTA.toLocaleString()} bytes/account`
        );
        console.log(
            `Accounts: ${accounts.length}`
        );
        console.log(
            `Client auth: ${CLIENT_AUTH_ENABLED ? 'ON' : 'OFF'}`
        );
        console.log(
            `IP whitelist: ${WHITELIST_ENABLED ? 'ON' : 'OFF'}`
        );
        console.log(
            `Health check: ${HEALTH_INTERVAL} ms`
        );
        console.log(
            'Reserved state: DISABLED'
        );
        console.log('======================================');
        console.log('');
    }
);

// ============================================================
// Status output
// ============================================================

function printStatus() {
    console.log('');
    console.log('========== STATUS ==========');

    for (let i = 0; i < accounts.length; i++) {
        const used = state.accounts[i].used;

        const percent =
            ((used / QUOTA) * 100).toFixed(2);

        const h = health[i];

        console.log(
            `#${i + 1}` +
            ` used=${used.toLocaleString()}` +
            `/${QUOTA.toLocaleString()}` +
            ` (${percent}%)` +
            ` health=${h.healthy ? 'OK' : 'FAIL'}`
        );

        if (h.lastError) {
            console.log(
                `   error=${h.lastError}`
            );
        }
    }

    console.log(
        `current=#${state.current + 1}`
    );

    console.log('============================');
    console.log('');
}

setInterval(
    printStatus,
    Number(config.server?.status_interval_ms || 60_000)
).unref();

// ============================================================
// Graceful shutdown
// ============================================================

function shutdown(signal) {
    console.log(
        `Received ${signal}, saving state...`
    );

    saveStateNow();

    server.close(() => {
        process.exit(0);
    });

    setTimeout(() => {
        process.exit(0);
    }, 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', err => {
    console.error(
        '[uncaughtException]',
        err
    );

    saveStateNow();
});

process.on('unhandledRejection', err => {
    console.error(
        '[unhandledRejection]',
        err
    );
});