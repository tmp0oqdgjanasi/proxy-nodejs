#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/proxy-nodejs"
SB_DIR="/etc/sing-box"
SB_CONFIG="$SB_DIR/config.json"

NODE_SERVICE="/etc/systemd/system/proxy-nodejs.service"
SB_SERVICE="/etc/systemd/system/sing-box.service"

# ==============================
# 基础检查
# ==============================

if [ "$EUID" -ne 0 ]; then
    echo "请使用 root 或 sudo 运行："
    echo "sudo ./install.sh"
    exit 1
fi

echo "======================================"
echo "  Proxy Node.js + sing-box 安装程序"
echo "======================================"

# ==============================
# 安装系统依赖
# ==============================

echo
echo "[1/8] 安装系统依赖..."

apt-get update

apt-get install -y \
    curl \
    wget \
    git \
    ca-certificates \
    openssl \
    jq \
    unzip

# ==============================
# 安装 Node.js
# ==============================

echo
echo "[2/8] 安装 Node.js 22..."

if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
fi

echo "Node.js: $(node -v)"
echo "npm:     $(npm -v)"

# ==============================
# 安装 sing-box
# ==============================

echo
echo "[3/8] 安装 sing-box..."

if ! command -v sing-box >/dev/null 2>&1; then
    bash <(curl -fsSL https://sing-box.app/deb-install.sh)
fi

echo
sing-box version

# ==============================
# 下载 Node.js 项目
# ==============================

echo
echo "[4/8] 安装 proxy-nodejs..."

mkdir -p /opt

if [ ! -d "$APP_DIR/.git" ]; then
    git clone \
        https://github.com/tmp0oqdgjanasi/proxy-nodejs.git \
        "$APP_DIR"
else
    echo "项目已经存在，跳过 clone。"
fi

cd "$APP_DIR"

npm install

# ==============================
# 创建目录
# ==============================

echo
echo "[5/8] 创建 sing-box 配置目录..."

mkdir -p "$SB_DIR"

chmod 700 "$SB_DIR"

# ==============================
# 随机生成 UUID
# ==============================

echo
echo "[6/8] 生成随机 Reality 参数..."

UUID="$(cat /proc/sys/kernel/random/uuid)"

# 生成 Reality KeyPair
KEY_OUTPUT="$(sing-box generate reality-keypair)"

PRIVATE_KEY="$(echo "$KEY_OUTPUT" | awk '/PrivateKey:/ {print $2}')"
PUBLIC_KEY="$(echo "$KEY_OUTPUT" | awk '/PublicKey:/ {print $2}')"

# 生成 8 字节 / 16 hex 字符 Short ID
SHORT_ID="$(openssl rand -hex 8)"

# ==============================
# 写入 sing-box 配置
# ==============================

echo
echo "[7/8] 创建 sing-box 配置..."

cat > "$SB_CONFIG" <<EOF
{
  "log": {
    "level": "info",
    "timestamp": true
  },

  "inbounds": [
    {
      "type": "vless",
      "tag": "vless-reality",
      "listen": "::",
      "listen_port": 443,

      "users": [
        {
          "name": "proxy-nodejs",
          "uuid": "$UUID"
        }
      ],

      "tls": {
        "enabled": true,
        "server_name": "bilibili.com",

        "reality": {
          "enabled": true,
          "handshake": {
            "server": "bilibili.com",
            "server_port": 443
          },
          "private_key": "$PRIVATE_KEY",
          "short_id": [
            "$SHORT_ID"
          ]
        }
      }
    },

    {
      "type": "http",
      "tag": "local-http",
      "listen": "127.0.0.1",
      "listen_port": 8080
    }
  ],

  "outbounds": [
    {
      "type": "direct",
      "tag": "direct"
    }
  ]
}
EOF

chmod 600 "$SB_CONFIG"

# ==============================
# proxy-nodejs systemd
# ==============================

cat > "$NODE_SERVICE" <<EOF
[Unit]
Description=Vital Data Node.js Proxy Relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node $APP_DIR/proxy.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# ==============================
# sing-box systemd
# ==============================

cat > "$SB_SERVICE" <<EOF
[Unit]
Description=sing-box
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/sing-box run -c $SB_CONFIG
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# ==============================
# 配置检查
# ==============================

echo
echo "检查 sing-box 配置..."

sing-box check -c "$SB_CONFIG"

# ==============================
# 启动服务
# ==============================

echo
echo "[8/8] 启动服务..."

systemctl daemon-reload

systemctl enable proxy-nodejs
systemctl enable sing-box

systemctl restart proxy-nodejs
systemctl restart sing-box

sleep 2

# ==============================
# 检查状态
# ==============================

echo
echo "======================================"
echo "          安装完成"
echo "======================================"

if systemctl is-active --quiet proxy-nodejs; then
    echo "proxy-nodejs : RUNNING"
else
    echo "proxy-nodejs : FAILED"
fi

if systemctl is-active --quiet sing-box; then
    echo "sing-box      : RUNNING"
else
    echo "sing-box      : FAILED"
fi

echo
echo "======================================"
echo "       Reality 连接参数"
echo "======================================"

echo
echo "UUID:"
echo "$UUID"

echo
echo "Private Key:"
echo "$PRIVATE_KEY"

echo
echo "Public Key:"
echo "$PUBLIC_KEY"

echo
echo "Short ID:"
echo "$SHORT_ID"

echo
echo "SNI / Server Name:"
echo "bilibili.com"

echo
echo "======================================"
echo "       文件位置"
echo "======================================"

echo
echo "Node.js:"
echo "$APP_DIR"

echo
echo "sing-box:"
echo "$SB_CONFIG"

echo
echo "======================================"
echo "       服务管理"
echo "======================================"

echo
echo "查看 sing-box:"
echo "systemctl status sing-box"

echo
echo "查看 Node.js:"
echo "systemctl status proxy-nodejs"

echo
echo "查看 sing-box 日志:"
echo "journalctl -u sing-box -f"

echo
echo "查看 Node.js 日志:"
echo "journalctl -u proxy-nodejs -f"

echo
echo "======================================"
echo "请保存上面的 UUID / Public Key /"
echo "Short ID 等参数。Private Key 不要泄露。"
echo "======================================"