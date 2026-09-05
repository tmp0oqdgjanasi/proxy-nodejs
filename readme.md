Proxy Node.js + sing-box

一个基于 Node.js 的 HTTP/HTTPS 代理中转项目，可配合 sing-box VLESS + Reality 使用。

项目结构

/opt/proxy-nodejs/
├── proxy.js
├── config.json
├── proxies.txt
├── package.json
└── README.md
/etc/sing-box/
└── config.json

整体架构：

客户端
   │
   │ VLESS + Reality
   ▼
sing-box
   │
   │ HTTP Proxy
   ▼
127.0.0.1:8080
   │
   ▼
proxy.js
   │
   ▼
上游代理

功能

* Node.js HTTP/HTTPS Proxy
* 支持 HTTP CONNECT
* 支持多个上游代理账号
* 上游账号自动轮换
* 每个账号独立流量额度
* 并发连接统一计量
* 达到额度后硬切连接
* 上游连接失败自动尝试其他账号
* 上游健康检查
* 本地 Basic Auth
* IP 白名单
* systemd 开机自启
* 可配合 sing-box VLESS + Reality

要求

推荐：

* Ubuntu 22.04 / 24.04
* Debian 12
* Node.js 22 LTS
* sing-box
* Git

一键安装

下载项目：

git clone https://github.com/tmp0oqdgjanasi/proxy-nodejs.git
cd proxy-nodejs

运行安装脚本：

chmod +x install.sh
sudo ./install.sh

安装脚本会自动：

1. 安装系统依赖
2. 安装 Node.js
3. 安装 sing-box
4. 下载/安装项目
5. 安装 npm 依赖
6. 随机生成 UUID
7. 随机生成 Reality KeyPair
8. 随机生成 Short ID
9. 创建 sing-box 配置
10. 创建 systemd 服务
11. 启动 Node.js 和 sing-box

Reality 参数

安装完成后，脚本会在终端输出：

UUID
Private Key
Public Key
Short ID
SNI / Server Name

这些参数用于客户端连接。

其中：

* UUID：VLESS 用户身份
* Public Key：客户端 Reality 公钥
* Short ID：Reality Short ID
* Private Key：仅服务器使用
* SNI / Server Name：Reality 使用的域名

安全说明

Private Key 不要发送给其他人，也不要提交到 GitHub。

UUID、Private Key、Short ID 等敏感参数不应该硬编码到项目源码中。

SNI

SNI 由 sing-box 的 Reality 配置控制。

Node.js 的 proxy.js 不负责 Reality，也不会修改 TLS ClientHello 的 SNI。

配置文件：

/etc/sing-box/config.json

例如：

{
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  }
}

example.com 仅作为示例。

生产环境应该使用你自己控制并正确配置的域名。

Node.js 代理

Node.js 项目默认监听：

127.0.0.1:8080

建议只允许 sing-box 从本机访问 Node.js Proxy。

这样可以避免直接把后端代理端口暴露到公网。

上游代理

上游代理配置在：

proxies.txt

格式：

HOST:PORT:USERNAME:PASSWORD

例如：

gw.vital-data.io:8888:USER1:PASSWORD1
gw.vital-data.io:8888:USER2:PASSWORD2
gw.vital-data.io:8888:USER3:PASSWORD3

不要把真实账号密码提交到公开 GitHub 仓库。

建议：

chmod 600 proxies.txt

流量额度

默认每个上游账号：

100,000,000 bytes

也就是十进制 100 MB。

程序会在单进程事件循环中同步完成额度检查和扣减：

检查剩余额度
     ↓
计算允许发送的字节数
     ↓
立即扣减
     ↓
发送数据

检查和扣减之间不会进行异步等待，因此多个并发连接不会因为 await 导致额度竞争。

硬切机制

如果当前账号剩余：

1000 bytes

但下一次数据需要：

5000 bytes

程序只允许：

1000 bytes

然后立即关闭当前连接。

不会继续使用已经达到额度上限的账号。

客户端需要重新建立连接，新的连接会选择其他可用账号。

已建立连接不会迁移

一个 TCP/HTTPS CONNECT 隧道建立后，会绑定当前上游账号。

如果该账号达到额度：

当前 TCP 连接
      ↓
达到额度
      ↓
硬切
      ↓
关闭连接
      ↓
客户端重新连接
      ↓
使用下一个账号

程序不会尝试在一个已经建立的 TCP/TLS 隧道中途透明迁移到另一个账号。

健康检查

程序会定期检查上游代理服务器是否可以建立 TCP 连接。

健康检查：

* 不计入代理流量额度
* 不修改账号已使用额度
* 失败账号进入冷却
* 冷却结束后自动重新尝试

systemd

安装完成后：

Node.js

systemctl status proxy-nodejs

重启：

systemctl restart proxy-nodejs

日志：

journalctl -u proxy-nodejs -f

sing-box

systemctl status sing-box

重启：

systemctl restart sing-box

日志：

journalctl -u sing-box -f

修改配置后

修改 Node.js：

nano /opt/proxy-nodejs/config.json

然后：

systemctl restart proxy-nodejs

修改 sing-box：

nano /etc/sing-box/config.json

检查：

sing-box check -c /etc/sing-box/config.json

确认没有错误后：

systemctl restart sing-box

安全建议

生产服务器建议：

* Node.js 只监听 127.0.0.1
* Reality 对外提供公网端口
* 使用强密码
* 不公开 proxies.txt
* 不公开 sing-box Private Key
* 不把真实 UUID/密钥提交到 GitHub
* 定期更新 Node.js 和 sing-box
* 使用防火墙限制不需要的端口

目录权限

建议：

chmod 600 /opt/proxy-nodejs/proxies.txt
chmod 600 /etc/sing-box/config.json
chmod 700 /etc/sing-box

常用命令

查看 Node.js：

node -v

查看 npm：

npm -v

查看 sing-box：

sing-box version

检查 sing-box：

sing-box check -c /etc/sing-box/config.json

查看端口：

ss -lntp

查看服务：

systemctl status proxy-nodejs
systemctl status sing-box

注意

本项目只负责代理中转和流量计量。

Reality、VLESS、TLS、SNI 等功能由 sing-box 负责。

请确保上游代理账号、域名以及服务器配置符合相应服务提供商的使用条款和当地法律法规。
