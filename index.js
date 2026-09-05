'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

/*
 * ============================================================
 * Pterodactyl Node.js + sing-box VLESS Reality Launcher
 * ============================================================
 *
 * 目录:
 *
 * /home/container/
 * ├── index.js
 * ├── proxy.js
 * ├── config.json
 * ├── proxies.txt
 * ├── package.json
 * └── data/
 *     ├── auth.json
 *     ├── identity.json
 *     └── sing-box.json
 *
 * 第一次启动:
 *   生成 Node Proxy 用户名/密码
 *   生成 UUID
 *   生成 Reality KeyPair
 *   生成 Short ID
 *   生成 sing-box 配置
 *
 * 后续启动:
 *   读取已有数据，不重新生成
 *
 * Pterodactyl Startup Command:
 *
 *   node /home/container/index.js
 *
 * ============================================================
 */

// ------------------------------------------------------------
// 基础路径
// ------------------------------------------------------------

const BASE_DIR = '/home/container';
const DATA_DIR = path.join(BASE_DIR, 'data');

const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const IDENTITY_FILE = path.join(DATA_DIR, 'identity.json');
const SINGBOX_CONFIG_FILE = path.join(DATA_DIR, 'sing-box.json');

const NODE_PROXY = path.join(BASE_DIR, 'proxy.js');

// ------------------------------------------------------------
// 环境变量
// ------------------------------------------------------------

// Pterodactyl 分配的公网端口
const SERVER_PORT = Number(process.env.SERVER_PORT || 20216);

// Pterodactyl Server IP
const SERVER_IP =
    process.env.SERVER_IP ||
    process.env.SERVER_HOST ||
    'YOUR_SERVER_IP';

// Reality SNI / Handshake
//
// 请改成你自己控制的域名。
// 不要使用第三方网站作为伪装目标。
const REALITY_SERVER_NAME =
    process.env.REALITY_SERVER_NAME ||
    'bilibili.com';

// Reality handshake 端口
const REALITY_HANDSHAKE_PORT = Number(
    process.env.REALITY_HANDSHAKE_PORT || 443
);

// sing-box 命令
const SING_BOX_BIN =
    process.env.SING_BOX_BIN ||
    'sing-box';

// Node.js proxy.js 本地端口
//
// 你的 proxy.js 当前 config.json 是 20216。
// 如果 sing-box 和 proxy.js 在同一个容器里，
// 不能让两个程序同时监听同一个端口。
//
// 因此默认让 Node.js 使用 20216，
// sing-box 使用 SERVER_PORT。
// 如果 SERVER_PORT 也是 20216，程序会自动改用 20217。
let NODE_PROXY_PORT = Number(
    process.env.NODE_PROXY_PORT || 20216
);

// ------------------------------------------------------------
// 工具函数
// ------------------------------------------------------------

function ensureDir(dir) {
    fs.mkdirSync(dir, {
        recursive: true,
        mode: 0o700
    });
}

function writeJsonSecure(file, data) {
    const tmp = `${file}.tmp-${process.pid}`;

    fs.writeFileSync(
        tmp,
        JSON.stringify(data, null, 2) + '\n',
        {
            mode: 0o600
        }
    );

    fs.renameSync(tmp, file);

    try {
        fs.chmodSync(file, 0o600);
    } catch (_) {}
}

function readJson(file) {
    return JSON.parse(
        fs.readFileSync(file, 'utf8')
    );
}

function randomString(length) {
    return crypto
        .randomBytes(Math.ceil(length * 0.8))
        .toString('base64url')
        .slice(0, length);
}

function generateShortId() {
    return crypto
        .randomBytes(4)
        .toString('hex');
}

function generateUUID() {
    return crypto.randomUUID();
}

// ------------------------------------------------------------
// 查找 sing-box
// ------------------------------------------------------------

function findSingBox() {
    const candidates = [
        SING_BOX_BIN,
        '/usr/local/bin/sing-box',
        '/usr/bin/sing-box',
        '/app/sing-box',
        '/home/container/sing-box'
    ];

    for (const candidate of candidates) {
        try {
            execFileSync(
                candidate,
                ['version'],
                {
                    stdio: 'ignore'
                }
            );

            return candidate;
        } catch (_) {}
    }

    console.error('');
    console.error('ERROR: sing-box executable not found.');
    console.error('');
    console.error('Please make sure sing-box is installed');
    console.error('inside this Pterodactyl container.');
    console.error('');

    process.exit(1);
}

// ------------------------------------------------------------
// 读取 / 生成 Node.js Proxy 认证
// ------------------------------------------------------------

function loadOrCreateAuth() {
    if (fs.existsSync(AUTH_FILE)) {
        const auth = readJson(AUTH_FILE);

        if (
            auth &&
            typeof auth.username === 'string' &&
            typeof auth.password === 'string'
        ) {
            return auth;
        }

        throw new Error(
            `Invalid auth file: ${AUTH_FILE}`
        );
    }

    const auth = {
        username: randomString(10),
        password: randomString(32),
        created_at: new Date().toISOString()
    };

    writeJsonSecure(
        AUTH_FILE,
        auth
    );

    return auth;
}

// ------------------------------------------------------------
// 生成 Reality KeyPair
// ------------------------------------------------------------

function generateRealityKeyPair(singBox) {
    console.log(
        '[INIT] Generating Reality key pair...'
    );

    let output;

    try {
        output = execFileSync(
            singBox,
            ['generate', 'reality-keypair'],
            {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe']
            }
        );
    } catch (err) {
        console.error(
            '[ERROR] Failed to generate Reality key pair.'
        );

        if (err.stderr) {
            console.error(
                err.stderr.toString()
            );
        }

        process.exit(1);
    }

    const privateMatch =
        output.match(/PrivateKey:\s*([^\s]+)/);

    const publicMatch =
        output.match(/PublicKey:\s*([^\s]+)/);

    if (!privateMatch || !publicMatch) {
        console.error(
            '[ERROR] Could not parse Reality key pair.'
        );

        console.error(output);

        process.exit(1);
    }

    return {
        private_key: privateMatch[1],
        public_key: publicMatch[1]
    };
}

// ------------------------------------------------------------
// 读取 / 生成永久身份
// ------------------------------------------------------------

function loadOrCreateIdentity(singBox) {
    if (fs.existsSync(IDENTITY_FILE)) {
        const identity =
            readJson(IDENTITY_FILE);

        if (
            identity &&
            identity.uuid &&
            identity.private_key &&
            identity.public_key &&
            identity.short_id
        ) {
            return identity;
        }

        throw new Error(
            `Invalid identity file: ${IDENTITY_FILE}`
        );
    }

    const keys =
        generateRealityKeyPair(singBox);

    const identity = {
        uuid: generateUUID(),

        private_key: keys.private_key,

        public_key: keys.public_key,

        short_id: generateShortId(),

        created_at:
            new Date().toISOString()
    };

    writeJsonSecure(
        IDENTITY_FILE,
        identity
    );

    return identity;
}

// ------------------------------------------------------------
// 处理端口
// ------------------------------------------------------------

function resolvePorts() {
    /*
     * 如果 sing-box 和 Node.js 使用相同端口，
     * Node.js 自动改到下一个端口。
     */

    if (
        SERVER_PORT > 0 &&
        SERVER_PORT === NODE_PROXY_PORT
    ) {
        NODE_PROXY_PORT =
            SERVER_PORT + 1;

        console.log(
            `[PORT] sing-box and Node.js cannot share ${SERVER_PORT}.`
        );

        console.log(
            `[PORT] Node.js proxy will use ${NODE_PROXY_PORT}.`
        );
    }

    return {
        singbox: SERVER_PORT,
        node: NODE_PROXY_PORT
    };
}

// ------------------------------------------------------------
// 修改 Node.js config.json
// ------------------------------------------------------------

function updateNodeConfig(nodePort) {
    const configFile =
        path.join(BASE_DIR, 'config.json');

    if (!fs.existsSync(configFile)) {
        console.warn(
            '[WARN] config.json not found.'
        );

        return;
    }

    try {
        const config =
            readJson(configFile);

        if (!config.listen) {
            config.listen = {};
        }

        /*
         * sing-box -> Node.js
         *
         * 两者同容器时建议 Node.js 只监听本地。
         */

        config.listen.host =
            process.env.NODE_PROXY_HOST ||
            '127.0.0.1';

        config.listen.port =
            nodePort;

        /*
         * 如果 Node.js 的 auth 配置使用
         * 固定用户名/密码，这里自动替换。
         */

        const auth =
            loadOrCreateAuth();

        if (!config.auth) {
            config.auth = {};
        }

        config.auth.enabled = true;
        config.auth.username =
            auth.username;
        config.auth.password =
            auth.password;

        writeJsonSecure(
            configFile,
            config
        );

        console.log(
            `[NODE] config.json updated: ${config.listen.host}:${config.listen.port}`
        );
    } catch (err) {
        console.error(
            '[WARN] Could not update config.json:'
        );

        console.error(err.message);
    }
}

// ------------------------------------------------------------
// 生成 sing-box 配置
// ------------------------------------------------------------

function createSingBoxConfig(identity, ports) {
    /*
     * VLESS + Reality
     *
     * sing-box 官方当前 VLESS inbound:
     * users[].uuid
     *
     * Reality:
     * private_key
     * short_id
     *
     * 出站 direct。
     */

    const config = {
        log: {
            level: 'info',
            timestamp: true
        },

        inbounds: [
            {
                type: 'vless',

                tag: 'vless-reality',

                listen: '0.0.0.0',

                listen_port: ports.singbox,

                users: [
                    {
                        uuid: identity.uuid,

                        flow: 'xtls-rprx-vision'
                    }
                ],

                tls: {
                    enabled: true,

                    server_name:
                        REALITY_SERVER_NAME,

                    reality: {
                        enabled: true,

                        handshake: {
                            server:
                                REALITY_SERVER_NAME,

                            server_port:
                                REALITY_HANDSHAKE_PORT
                        },

                        private_key:
                            identity.private_key,

                        short_id: [
                            identity.short_id
                        ]
                    }
                }
            }
        ],

        outbounds: [
            {
                type: 'http',

                tag: 'node-proxy',

                server: '127.0.0.1',

                server_port:
                    ports.node,

                username:
                    loadOrCreateAuth().username,

                password:
                    loadOrCreateAuth().password
            }
        ],

        route: {
            final: 'node-proxy'
        }
    };

    writeJsonSecure(
        SINGBOX_CONFIG_FILE,
        config
    );

    return config;
}

// ------------------------------------------------------------
// 检查 sing-box 配置
// ------------------------------------------------------------

function checkSingBoxConfig(singBox) {
    console.log('');
    console.log(
        '[SING-BOX] Checking configuration...'
    );

    try {
        execFileSync(
            singBox,
            [
                'check',
                '-c',
                SINGBOX_CONFIG_FILE
            ],
            {
                stdio: 'inherit'
            }
        );
    } catch (err) {
        console.error('');
        console.error(
            '[ERROR] sing-box configuration check failed.'
        );

        process.exit(1);
    }

    console.log(
        '[SING-BOX] Configuration OK.'
    );
}

// ------------------------------------------------------------
// VLESS URL
// ------------------------------------------------------------

function buildVlessUrl(identity, port) {
    const params = new URLSearchParams();

    params.set(
        'encryption',
        'none'
    );

    params.set(
        'flow',
        'xtls-rprx-vision'
    );

    params.set(
        'security',
        'reality'
    );

    params.set(
        'sni',
        REALITY_SERVER_NAME
    );

    params.set(
        'fp',
        'chrome'
    );

    params.set(
        'pbk',
        identity.public_key
    );

    params.set(
        'sid',
        identity.short_id
    );

    params.set(
        'type',
        'tcp'
    );

    params.set(
        'headerType',
        'none'
    );

    return (
        `vless://${identity.uuid}` +
        `@${SERVER_IP}:${port}` +
        `?${params.toString()}` +
        `#Node-Relay`
    );
}

// ------------------------------------------------------------
// 启动 sing-box
// ------------------------------------------------------------

function startSingBox(singBox) {
    console.log('');
    console.log(
        '[SING-BOX] Starting...'
    );

    const child =
        spawn(
            singBox,
            [
                'run',
                '-c',
                SINGBOX_CONFIG_FILE
            ],
            {
                cwd: BASE_DIR,

                env: {
                    ...process.env
                },

                stdio: [
                    'ignore',
                    'pipe',
                    'pipe'
                ]
            }
        );

    child.stdout.on(
        'data',
        data => {
            process.stdout.write(
                `[sing-box] ${data}`
            );
        }
    );

    child.stderr.on(
        'data',
        data => {
            process.stderr.write(
                `[sing-box] ${data}`
            );
        }
    );

    child.on(
        'error',
        err => {
            console.error(
                '[SING-BOX] Process error:',
                err.message
            );
        }
    );

    child.on(
        'exit',
        (code, signal) => {
            console.error(
                `[SING-BOX] exited code=${code} signal=${signal}`
            );

            /*
             * sing-box 退出后，
             * 整个 Pterodactyl Server 退出，
             * 让面板 restart policy 接管。
             */

            process.exit(
                code || 1
            );
        }
    );

    return child;
}

// ------------------------------------------------------------
// 启动 Node.js proxy.js
// ------------------------------------------------------------

function startNodeProxy() {
    console.log('');
    console.log(
        '[NODE] Starting proxy.js...'
    );

    const child =
        spawn(
            process.execPath,
            [
                NODE_PROXY
            ],
            {
                cwd: BASE_DIR,

                env: {
                    ...process.env
                },

                stdio: 'inherit'
            }
        );

    child.on(
        'error',
        err => {
            console.error(
                '[NODE] Process error:',
                err.message
            );
        }
    );

    child.on(
        'exit',
        (code, signal) => {
            console.error(
                `[NODE] proxy.js exited code=${code} signal=${signal}`
            );

            process.exit(
                code || 1
            );
        }
    );

    return child;
}

// ------------------------------------------------------------
// 输出信息
// ------------------------------------------------------------

function printInfo(
    auth,
    identity,
    ports
) {
    const vlessUrl =
        buildVlessUrl(
            identity,
            ports.singbox
        );

    console.log('');
    console.log(
        '============================================================'
    );

    console.log(
        '             NODE.JS + SING-BOX STARTED'
    );

    console.log(
        '============================================================'
    );

    console.log('');

    console.log(
        `Server IP       : ${SERVER_IP}`
    );

    console.log(
        `VLESS Port      : ${ports.singbox}`
    );

    console.log(
        `Node Proxy      : 127.0.0.1:${ports.node}`
    );

    console.log('');

    console.log(
        '---------------- NODE PROXY AUTH ----------------'
    );

    console.log(
        `Username        : ${auth.username}`
    );

    console.log(
        `Password        : ${auth.password}`
    );

    console.log('');

    console.log(
        '---------------- VLESS REALITY -------------------'
    );

    console.log(
        `UUID            : ${identity.uuid}`
    );

    console.log(
        `Public Key      : ${identity.public_key}`
    );

    console.log(
        `Short ID        : ${identity.short_id}`
    );

    console.log(
        `SNI             : ${REALITY_SERVER_NAME}`
    );

    console.log('');

    console.log(
        '---------------- VLESS LINK ---------------------'
    );

    console.log(vlessUrl);

    console.log('');

    console.log(
        'Credentials are permanently stored under:'
    );

    console.log(
        '/home/container/data/'
    );

    console.log('');

    console.log(
        '============================================================'
    );

    console.log('');
}

// ------------------------------------------------------------
// 主程序
// ------------------------------------------------------------

async function main() {
    console.log('');
    console.log(
        'Starting Pterodactyl Node.js + sing-box launcher...'
    );

    ensureDir(DATA_DIR);

    // 1. 查找 sing-box
    const singBox =
        findSingBox();

    console.log(
        `[SING-BOX] ${singBox}`
    );

    // 2. 端口
    const ports =
        resolvePorts();

    // 3. Node Proxy Auth
    const auth =
        loadOrCreateAuth();

    // 4. UUID + Reality
    const identity =
        loadOrCreateIdentity(
            singBox
        );

    // 5. 修改 Node.js config
    updateNodeConfig(
        ports.node
    );

    // 6. 生成 sing-box 配置
    createSingBoxConfig(
        identity,
        ports
    );

    // 7. 检查配置
    checkSingBoxConfig(
        singBox
    );

    // 8. 打印 VLESS
    printInfo(
        auth,
        identity,
        ports
    );

    // 9. 启动 sing-box
    const singBoxProcess =
        startSingBox(
            singBox
        );

    // 给 sing-box 一点启动时间
    await new Promise(
        resolve =>
            setTimeout(
                resolve,
                1200
            )
    );

    // 10. 启动 Node.js Proxy
    const nodeProcess =
        startNodeProxy();

    // --------------------------------------------------------
    // 信号处理
    // --------------------------------------------------------

    let shuttingDown = false;

    function shutdown(signal) {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;

        console.log('');
        console.log(
            `[MAIN] Received ${signal}, shutting down...`
        );

        try {
            nodeProcess.kill(
                'SIGTERM'
            );
        } catch (_) {}

        try {
            singBoxProcess.kill(
                'SIGTERM'
            );
        } catch (_) {}

        setTimeout(
            () => {
                process.exit(0);
            },
            3000
        );
    }

    process.on(
        'SIGTERM',
        () => shutdown('SIGTERM')
    );

    process.on(
        'SIGINT',
        () => shutdown('SIGINT')
    );
}

main().catch(
    err => {
        console.error('');
        console.error(
            '[FATAL]',
            err
        );

        process.exit(1);
    }
);