# Vital Data Hard-Cut Relay

一个基于 Node.js 原生 `net` 模块的 HTTP/HTTPS CONNECT 代理中转。

主要用于：

    Client
       |
       v
    Reality / VLESS
       |
       v
    Node.js Relay
       |
       +---- Vital Data Account 1
       |
       +---- Vital Data Account 2
       |
       +---- Vital Data Account 3
       |
       +---- ...

每个 Vital Data 账号严格限制为：

    100,000,000 bytes

达到额度以后：

    只发送剩余允许字节
             |
             v
        立即硬切连接
             |
             v
        下一个账号

---

# 1. 特性

- 多个 Vital Data 账号
- 全局账号额度
- 每账号 100,000,000 bytes
- 并发客户端安全
- 不使用 `reserved`
- `state.json` 只保存 `used`
- HTTP proxy
- HTTPS CONNECT proxy
- 客户端用户名/密码认证
- IP 白名单
- 上游健康检查
- 上游 TCP 连接失败自动尝试其他账号
- 账号故障冷却
- 状态持久化
- Node.js 原生模块
- 不需要 npm 依赖
- 配额达到以后硬切
- 不自动重置已经用完的账号

---

# 2. 系统要求

Node.js >= 18

检查：

    node -v

例如：

    v20.x
    v22.x

---

# 3. 文件结构

最终目录：

    vital-relay/
    ├── proxy.js
    ├── package.json
    ├── proxies.txt
    ├── config.json
    ├── state.json
    └── README.md

第一次启动时如果没有 `state.json`，程序会自动创建。

---

# 4. proxies.txt

格式：

    HOST:PORT:USERNAME:PASSWORD

例如：

    gw.vital-data.io:8888:USER1:PASSWORD1
    gw.vital-data.io:8888:USER2:PASSWORD2
    gw.vital-data.io:8888:USER3:PASSWORD3

密码可以包含 `:`。

例如：

    gw.vital-data.io:8888:user:abc:def

解析结果：

    Host:
        gw.vital-data.io

    Port:
        8888

    Username:
        user

    Password:
        abc:def

不要把真实账号密码提交到 Git 仓库。

建议：

    chmod 600 proxies.txt

---

# 5. config.json

示例：

    {
      "listen": {
        "host": "127.0.0.1",
        "port": 8080
      },

      "quota": {
        "bytes_per_account": 100000000
      },

      "auth": {
        "enabled": true,
        "username": "relayuser",
        "password": "CHANGE_THIS_PASSWORD"
      },

      "ip_whitelist": {
        "enabled": true,
        "ips": [
          "127.0.0.1",
          "YOUR_CLIENT_IP"
        ]
      },

      "upstream": {
        "connect_timeout_ms": 15000,
        "retry_on_connect_failure": true
      },

      "health_check": {
        "interval_ms": 30000,
        "timeout_ms": 5000,
        "failure_cooldown_ms": 60000
      },

      "server": {
        "max_header_bytes": 65536,
        "max_connections": 1000,
        "status_interval_ms": 60000
      },

      "reality": {
        "server_name": "example.com"
      }
    }

---

# 6. 客户端认证

默认：

    "auth": {
      "enabled": true,
      "username": "relayuser",
      "password": "CHANGE_THIS_PASSWORD"
    }

客户端连接代理时使用：

    Username:
        relayuser

    Password:
        CHANGE_THIS_PASSWORD

认证方式：

    HTTP Basic Proxy Authentication

认证失败返回：

    HTTP 407 Proxy Authentication Required

生产环境务必修改默认密码。

---

# 7. IP 白名单

例如：

    "ip_whitelist": {
      "enabled": true,
      "ips": [
        "127.0.0.1",
        "1.2.3.4",
        "5.6.7.8"
      ]
    }

只有这些 IP 可以连接 Relay。

不在列表中的 IP：

    HTTP 403

如果 Relay 只接受本机 Reality 服务连接：

    "ips": [
      "127.0.0.1"
    ]

并将：

    listen.host

设置为：

    127.0.0.1

推荐这样部署。

---

# 8. 启动

进入目录：

    cd vital-relay

直接运行：

    node proxy.js

或者：

    npm start

启动后类似：

    ======================================
     Vital Data Hard-Cut Relay
    ======================================
    Listen: 127.0.0.1:8080
    Quota: 100,000,000 bytes/account
    Accounts: 4
    Client auth: ON
    IP whitelist: ON
    Health check: 30000 ms
    Reserved state: DISABLED
    ======================================

---

# 9. 测试

如果 Relay 监听：

    127.0.0.1:8080

使用 curl：

    curl \
      -x http://relayuser:CHANGE_THIS_PASSWORD@127.0.0.1:8080 \
      https://api.ipify.org

或者：

    curl \
      --proxy http://127.0.0.1:8080 \
      --proxy-user relayuser:CHANGE_THIS_PASSWORD \
      https://api.ipify.org

---

# 10. 配额规则

每个账号：

    100,000,000 bytes

注意：

    100,000,000 bytes

不是：

    100 MiB

也不是：

    104,857,600 bytes

这里使用十进制。

---

# 11. 统计方向

当前 Relay 将以下两个方向统一计入当前账号：

    Client -> Vital
    Vital  -> Client

例如：

    Client -> Vital
        40 MB

    Vital -> Client
        60 MB

总计：

    100 MB

即：

    100,000,000 bytes

达到额度以后立即硬切。

---

# 12. 严格硬切

假设：

    quota = 100,000,000

当前：

    used = 99,999,700

客户端下一次发送：

    1,000 bytes

程序只允许：

    300 bytes

发送：

    300 bytes

然后：

    destroy client
    destroy upstream

剩余：

    700 bytes

不会继续发送。

最终：

    used = 100,000,000

---

# 13. 为什么没有 reserved

这个版本故意不保存：

    reserved

只保存：

    used

原因是避免：

    reserve
       |
       v
    await socket operation
       |
       v
    socket crash
       |
       v
    reserved 没释放

最终造成：

    幽灵额度

本版本采用同步额度分配：

    available = quota - used

    allowed = min(requested, available)

    used += allowed

整个检查和增加 `used` 的过程不会跨 `await`。

因此多个客户端同时发送时不会同时拿到相同额度。

---

# 14. 并发示例

假设：

    Account 1 used:
    99,999,000

剩余：

    1,000 bytes

同时有两个客户端。

Client A：

    请求 800 bytes

Client B：

    请求 800 bytes

Node.js 会同步处理额度分配。

Client A：

    available = 1000
    allocate = 800

结果：

    used = 99,999,800

Client B：

    available = 200
    allocate = 200

结果：

    used = 100,000,000

因此：

    A = 800
    B = 200

不会出现：

    A = 800
    B = 800

最终超过：

    1,000 bytes

---

# 15. 账号切换

例如：

    Account 1:
        100,000,000 / 100,000,000

    Account 2:
         30,000,000 / 100,000,000

    Account 3:
          0 / 100,000,000

Account 1 用完以后：

    新连接
        |
        v
    Account 2

Account 2 用完以后：

    新连接
        |
        v
    Account 3

注意：

已经建立的 TCP/HTTPS CONNECT 隧道不会在中途把 TCP 连接“搬迁”到另一个账号。

原因是：

    TCP/TLS 状态属于原连接。

因此严格硬切时：

    当前连接达到额度
        |
        v
    当前连接断开
        |
        v
    客户端重新连接
        |
        v
    下一个账号

这是有意设计的。

---

# 16. state.json

程序自动生成：

    {
      "current": 1,
      "accounts": [
        {
          "used": 100000000
        },
        {
          "used": 32768192
        },
        {
          "used": 0
        }
      ]
    }

只有：

    used

和：

    current

不会保存：

    reserved

---

# 17. 重启

程序重启以后：

    state.json

会继续使用原来的额度。

例如：

    Account 1:
    80,000,000

重启以后仍然：

    80,000,000

不会自动变成：

    0

---

# 18. 手动重置

如果你确定所有账号的额度需要重新开始，可以停止程序：

    Ctrl+C

然后删除：

    state.json

例如：

    rm state.json

再次启动：

    npm start

程序会重新建立：

    used = 0

注意：

只有在你确定供应商侧额度已经允许重新使用时才应该这么做。

---

# 19. 所有账号用完

如果：

    Account 1 = 100,000,000
    Account 2 = 100,000,000
    Account 3 = 100,000,000

所有账号都达到额度以后，不会自动把它们重置为 0。

新连接会得到：

    HTTP 503 Service Unavailable

这是为了防止 Relay 在不知道供应商实际额度状态的情况下继续使用已经达到内部限制的账号。

---

# 20. 健康检查

默认：

    interval:
        30 seconds

每个账号进行 TCP 健康检查。

如果账号无法连接：

    healthy = false

进入故障冷却：

    60 seconds

故障账号在冷却期间不会作为新的连接目标。

恢复以后：

    healthy = true

重新参与账号选择。

健康检查不会增加：

    state.accounts[].used

也不会消耗 Relay 配额。

---

# 21. 上游连接失败自动切换

例如当前账号：

    Account 1

连接 Vital Data 失败。

Relay 会尝试其他可用账号：

    Account 2
    Account 3
    Account 4

直到找到能够建立上游连接的账号。

注意：

这个自动切换主要发生在“建立上游连接之前”。

如果 HTTPS CONNECT 隧道已经建立并且开始传输 TLS 数据，中途上游断开时不会强行把已有 TLS/TCP 会话迁移到另一个账号。

否则可能造成：

    TCP sequence
    TLS state
    application state

不一致。

---

# 22. Reality

本 Relay 不实现 VLESS/Reality。

推荐架构：

    Client
       |
       | VLESS + Reality
       v
    Reality Server
       |
       | localhost
       v
    127.0.0.1:8080
       |
       v
    Node Relay
       |
       v
    Vital Data

`config.json` 中：

    "reality": {
      "server_name": "example.com"
    }

只是给整体部署保留的占位配置。

实际 Reality 服务端应该由：

    Xray
    或
    sing-box

负责。

这里使用：

    example.com

只是示例。

---

# 23. 安全建议

如果 Reality 和 Relay 在同一台服务器：

    listen.host = 127.0.0.1

不要：

    0.0.0.0:8080

直接暴露公网。

如果必须公网监听：

    开启用户名密码认证

并：

    开启 IP whitelist

另外：

    chmod 600 proxies.txt
    chmod 600 config.json
    chmod 600 state.json

不要把：

    proxies.txt
    config.json
    state.json

提交到公开 Git 仓库。

---

# 24. systemd

创建：

    /etc/systemd/system/vital-relay.service

内容：

    [Unit]
    Description=Vital Data Hard-Cut Relay
    After=network-online.target
    Wants=network-online.target

    [Service]
    Type=simple
    User=root
    WorkingDirectory=/opt/vital-relay
    ExecStart=/usr/bin/node /opt/vital-relay/proxy.js
    Restart=always
    RestartSec=3

    NoNewPrivileges=true

    [Install]
    WantedBy=multi-user.target

然后：

    sudo systemctl daemon-reload

启动：

    sudo systemctl enable vital-relay
    sudo systemctl start vital-relay

查看：

    sudo systemctl status vital-relay

日志：

    journalctl -u vital-relay -f

---

# 25. 防火墙

如果 Relay 只给本机 Reality 使用：

    不需要开放 8080

只开放你的 Reality 服务端口。

如果 Relay 本身需要被其他机器访问，则只允许可信 IP。

例如使用 UFW：

    sudo ufw allow from YOUR_CLIENT_IP to any port 8080 proto tcp

不要直接：

    ufw allow 8080/tcp

然后把代理裸奔在公网。

---

# 26. 性能

Node.js 的 `net.Socket` 本身支持高并发连接。

本程序没有使用：

    express
    axios
    http-proxy
    socks-proxy-agent

因此中间层比较轻。

实际速度主要受：

    Client -> VPS
    VPS -> Vital Data
    Vital Data -> Target
    Target -> Vital Data

以及 VPS 本身线路影响。

Relay 本身不会把慢线路自动变成快线路。

---

# 27. 关于字节计数

本程序的：

    100,000,000 bytes

是 Relay 应用层看到并允许进入 socket 写队列的数据量。

它不保证等于 Vital Data 后台的最终计费字节。

供应商可能按照自己的网络层/代理层规则计算流量。

因此：

    Relay used
    !=
    必然等于
    Provider billing

如果供应商侧的限制是绝对不能超过某个数值，建议将内部阈值设置得低于供应商限制，例如：

    95,000,000

而不是直接使用：

    100,000,000

---

# 28. 配置完成后的推荐目录

    /opt/vital-relay/

        proxy.js
        package.json
        proxies.txt
        config.json
        state.json
        README.md

权限：

    chmod 700 /opt/vital-relay

    chmod 600 /opt/vital-relay/proxies.txt
    chmod 600 /opt/vital-relay/config.json
    chmod 600 /opt/vital-relay/state.json

---

# 29. 最终启动

进入目录：

    cd /opt/vital-relay

检查：

    node -v

启动：

    node proxy.js

或者：

    npm start

看到：

    Reserved state: DISABLED

说明当前版本没有使用持久化 `reserved`。

---

# 30. 核心工作流程

    Client
       |
       v
    IP whitelist
       |
       v
    Proxy authentication
       |
       v
    Select healthy account
       |
       v
    Connect Vital Data
       |
       v
    Relay traffic
       |
       v
    allocateBytes()
       |
       +---- available > 0
       |          |
       |          v
       |      write allowed bytes
       |
       +---- available == 0
                  |
                  v
              hard cut
                  |
                  v
            next connection
                  |
                  v
             next account

---

# 31. 设计原则

本版本最重要的原则：

    不保存 reserved

    不跨 await 进行额度检查和增加

    不允许 chunk 超过剩余额度

    不允许账号 used > 100,000,000

    达到额度立即硬切

    不自动重置已用账号

    不迁移已经建立的 TCP/TLS 隧道

这样可以避免由于异步 socket 生命周期造成的：

    reserved 泄漏

    幽灵额度

    并发超额

    重启后预留额度残留