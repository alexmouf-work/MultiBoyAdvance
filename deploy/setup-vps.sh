#!/usr/bin/env bash
# One-time provisioning of a fresh Ubuntu VPS (22.04/24.04, x86 or ARM) to host
# MultiBoyAdvance and future friend-scale services behind Caddy.
#
#   curl -fsSL https://raw.githubusercontent.com/alexmouf-work/MultiBoyAdvance/main/deploy/setup-vps.sh \
#     | sudo bash -s -- mba.mouftools.com
#
# After this, deploy the app from your PC with scripts/deploy-mba.ps1
# (or deploy/deploy-mba.sh from WSL/macOS/Linux).
set -euo pipefail

DOMAIN="${1:-mba.mouftools.com}"
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }

echo "[mba-vps] Node.js 22 (NodeSource)..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

echo "[mba-vps] Caddy (official repo)..."
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

# Oracle's Ubuntu images ship a default-deny iptables INPUT chain (this is in
# addition to the cloud Security List). Open 80/443 just before the REJECT rule.
if iptables -L INPUT -n --line-numbers | grep -q REJECT; then
  echo "[mba-vps] opening iptables 80/443 (Oracle image default-deny)..."
  for PORT in 80 443; do
    if ! iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null; then
      LINE=$(iptables -L INPUT --line-numbers | awk '/REJECT/{print $1; exit}')
      iptables -I INPUT "$LINE" -p tcp --dport "$PORT" -j ACCEPT
    fi
  done
  command -v netfilter-persistent >/dev/null && netfilter-persistent save || true
fi

echo "[mba-vps] app user + directories..."
id -u mba >/dev/null 2>&1 || useradd -r -m -d /opt/mba -s /usr/sbin/nologin mba
mkdir -p /opt/mba/server /opt/mba/web /opt/mba/rom/build
chown -R mba:mba /opt/mba

echo "[mba-vps] systemd unit..."
cat > /etc/systemd/system/mba.service <<'UNIT'
[Unit]
Description=MultiBoyAdvance world server
After=network.target

[Service]
User=mba
WorkingDirectory=/opt/mba/server
# Caddy terminates TLS on 80/443 and proxies here; bind loopback only.
Environment=MBA_HOST=127.0.0.1
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable mba

echo "[mba-vps] Caddyfile for ${DOMAIN} (automatic Let's Encrypt)..."
cat > /etc/caddy/Caddyfile <<CADDY
${DOMAIN} {
    encode gzip
    reverse_proxy 127.0.0.1:8484
}

# More friend-scale projects on this box? One block each:
# project2.mouftools.com {
#     reverse_proxy 127.0.0.1:3000
# }
CADDY
systemctl reload caddy

echo "[mba-vps] done. Next steps:"
echo "  1. Point ${DOMAIN}'s A record at this box's public IP (reserved/static)."
echo "  2. From your PC:  scripts\\deploy-mba.ps1 -HostAddr <this-ip>"
echo "  3. Open https://${DOMAIN}"
