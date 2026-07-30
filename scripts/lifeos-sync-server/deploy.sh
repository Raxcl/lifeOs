#!/bin/bash
set -e
echo "=== [1/4] 安装 Python 依赖 ==="
pip3 install flask bcrypt requests 2>&1 | tail -3

echo "=== [2/4] 部署 server.py ==="
mkdir -p /opt/lifeos-sync-server
cp /tmp/server.py /opt/lifeos-sync-server/server.py
mkdir -p /home/syncthing/vaults
chown -R syncthing:syncthing /home/syncthing/vaults

echo "=== [3/4] 创建 systemd 服务 ==="
cat > /etc/systemd/system/lifeos-sync-api.service << 'UNIT'
[Unit]
Description=LifeOS Sync Registration API
After=network.target syncthing@syncthing.service

[Service]
Type=simple
ExecStart=/usr/bin/python3 /opt/lifeos-sync-server/server.py
Restart=on-failure
RestartSec=5
WorkingDirectory=/opt/lifeos-sync-server

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable lifeos-sync-api
systemctl start lifeos-sync-api
sleep 2
systemctl is-active lifeos-sync-api

echo "=== [4/4] 开放端口 8385 ==="
if command -v firewall-cmd &>/dev/null && systemctl is-active firewalld &>/dev/null; then
    firewall-cmd --permanent --add-port=8385/tcp
    firewall-cmd --reload
    echo "firewalld 已开放 8385"
else
    echo "firewalld 未运行，跳过（需在腾讯云安全组开放 8385）"
fi

echo "=== 验证 ==="
curl -s http://127.0.0.1:8385/api/status
echo ""
echo "=== DONE ==="
