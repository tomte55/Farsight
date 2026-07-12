#!/usr/bin/env bash
# Farsight coturn (TURN relay) deploy.
# Run from a repo checkout:  sudo bash infra/coturn/deploy.sh
# (create infra/.env from infra/.env.example first)
# Idempotent-ish: safe to re-run. Requires ${TURN_DOMAIN} DNS -> this server's
# public IP, and the router forwarding 3478 udp/tcp, 5349 tcp, 49160-49200 udp.
set -euo pipefail

# Load deployment-specific settings (domains, user, paths).
ENV_DIR="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "${ENV_DIR}/.env" ] || { echo "ERROR: create infra/.env from infra/.env.example first"; exit 1; }
set -a; . "${ENV_DIR}/.env"; set +a
: "${TURN_DOMAIN:?set TURN_DOMAIN in infra/.env}"
: "${DEPLOY_USER:?set DEPLOY_USER in infra/.env}"
: "${SIGNAL_COMPOSE_DIR:?set SIGNAL_COMPOSE_DIR in infra/.env}"

PUB=$(getent hosts "${TURN_DOMAIN}" | awk '{print $1; exit}')
PRIV=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
: "${PUB:?could not resolve ${TURN_DOMAIN} — add the DNS A record first}"
: "${PRIV:?could not detect private IP}"
echo ">> public IP (${TURN_DOMAIN}): $PUB"
echo ">> private IP:                  $PRIV"

### 1) Caddy vhost so Caddy issues an LE cert for ${TURN_DOMAIN} (coturn turns:)
if ! grep -q "${TURN_DOMAIN}" /etc/caddy/Caddyfile; then
  cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak-$(date +%Y%m%d-%H%M%S)"
  cat >> /etc/caddy/Caddyfile <<EOF

# Farsight — vhost so Caddy issues an LE cert used by coturn (turns:)
${TURN_DOMAIN} {
	respond 204
}
EOF
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  systemctl reload caddy
  echo ">> caddy vhost for ${TURN_DOMAIN} added + reloaded"
else
  echo ">> caddy vhost for ${TURN_DOMAIN} already present"
fi

### 2) wait for the cert, then 3) export to /certs (coturn runs as nobody:65534; key 600 = R-7)
CERT=""
for i in $(seq 1 30); do
  CERT=$(find /var/lib/caddy -path "*certificates*" -name "${TURN_DOMAIN}.crt" 2>/dev/null | head -1)
  [ -n "$CERT" ] && break
  sleep 2
done
[ -n "$CERT" ] || { echo "ERROR: cert not issued yet — check: journalctl -u caddy | tail -20"; exit 1; }
KEY="${CERT%.crt}.key"
mkdir -p /certs
install -m 644 -o root  -g root  "$CERT" "/certs/${TURN_DOMAIN}.crt"
install -m 600 -o 65534 -g 65534 "$KEY"  "/certs/${TURN_DOMAIN}.key"
echo ">> cert exported to /certs:"; ls -la /certs

### 4) TURN secret shared between coturn (static-auth-secret) and signaling (TURN_SECRET)
SECRET=$(openssl rand -hex 32)

### 5) coturn compose dir + config
mkdir -p /srv/compose/farsight-coturn
cat > /srv/compose/farsight-coturn/turnserver.conf <<EOF
listening-port=3478
tls-listening-port=5349
fingerprint
use-auth-secret
static-auth-secret=${SECRET}
realm=${TURN_DOMAIN}
# Pin coturn to the LAN interface (ignore docker bridges / tailscale / loopback)
# and advertise the public IP for relay candidates (1:1 NAT mapping):
listening-ip=${PRIV}
relay-ip=${PRIV}
external-ip=${PUB}/${PRIV}
# Relay port range (must be open on the firewall/router):
min-port=49160
max-port=49200
# TLS cert (Let's Encrypt, exported from Caddy):
cert=/certs/${TURN_DOMAIN}.crt
pkey=/certs/${TURN_DOMAIN}.key
# Hardening:
no-cli
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
# R-1: quotas, short nonce lifetime, no TCP relay:
total-quota=100
user-quota=6
bps-capacity=0
stale-nonce=600
no-tcp-relay
EOF

cat > /srv/compose/farsight-coturn/docker-compose.yml <<'EOF'
services:
  coturn:
    image: coturn/coturn:4.6
    container_name: farsight-coturn
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./turnserver.conf:/etc/coturn/turnserver.conf:ro
      - /certs:/certs:ro
    command: ["-c", "/etc/coturn/turnserver.conf"]
EOF

### 6) deploy coturn
( cd /srv/compose/farsight-coturn && docker compose up -d )
sleep 2
echo ">> coturn logs:"; docker logs farsight-coturn 2>&1 | tail -15 || true

### 7) wire the signaling server's TURN env and recreate it
ENV="${SIGNAL_COMPOSE_DIR}/packages/signaling-server/.env"
grep -vE '^TURN_SECRET=|^TURN_URI=|^TURNS_URI=|^TURN_TTL_SECONDS=' "$ENV" > "${ENV}.tmp" 2>/dev/null || true
mv "${ENV}.tmp" "$ENV"
cat >> "$ENV" <<EOF
TURN_SECRET=${SECRET}
TURN_URI=turn:${TURN_DOMAIN}:3478
TURNS_URI=turns:${TURN_DOMAIN}:5349?transport=tcp
TURN_TTL_SECONDS=300
EOF
# M6 audit remediation: the .env holds TURN_SECRET — restrict it to the owner
# (docker daemon reads it as root regardless). Never world-readable.
chown "${DEPLOY_USER}:${DEPLOY_USER}" "$ENV" 2>/dev/null || true
chmod 600 "$ENV"
( cd "${SIGNAL_COMPOSE_DIR}" && docker compose -f packages/signaling-server/docker-compose.yml up -d --build )
sleep 2
echo ">> signaling logs:"; docker logs farsight-signaling 2>&1 | tail -5 || true

### 8) host firewall (harmless if ufw is inactive)
ufw allow 3478/udp; ufw allow 3478/tcp; ufw allow 5349/tcp; ufw allow 49160:49200/udp
ufw status verbose | grep -E "Status|3478|5349|49160" || true

echo ""
echo "=== DEPLOY COMPLETE ==="
docker ps --filter name=farsight --format "{{.Names}} | {{.Status}}"
echo ">> listeners:"; ss -lun | grep ':3478' || echo "  (3478/udp not visible — check coturn logs above)"
