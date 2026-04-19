#!/usr/bin/env bash
# Boot the inari-web Redis accessory on the Hetzner host.
#
# Replicates `kamal accessory boot redis` for the case where Kamal CLI is
# not installed locally. Reads REDIS_PASSWORD from stdin, never echoes it,
# and ships it through SSH stdin to remote so it never enters argv,
# environment dump, or shell history on either side.
#
# Usage (from web/):
#
#   PowerShell:
#     & "C:\Users\jesus\bin\sops.exe" -d --output-type dotenv .env.sops.yaml `
#       | Select-String '^REDIS_PASSWORD=' `
#       | ForEach-Object { ($_ -replace '^REDIS_PASSWORD=', '').Trim() } `
#       | bash scripts/boot-redis-accessory.sh
#
#   Git-bash:
#     /c/Users/jesus/bin/sops.exe -d --output-type dotenv .env.sops.yaml \
#       | grep ^REDIS_PASSWORD= | cut -d= -f2- \
#       | bash scripts/boot-redis-accessory.sh
#
# Idempotent: tears down any prior inari-web-redis container.
# Persistent volume /var/lib/inari-web-redis survives reboots.

set -euo pipefail

HOST="${REDIS_ACCESSORY_HOST:-root@87.99.153.227}"

# Read password from stdin (single line, trimmed). Never written or echoed
# from this script's perspective.
read -r PASS
if [ -z "$PASS" ]; then
  echo "fatal: empty REDIS_PASSWORD on stdin" >&2
  exit 1
fi

# Stage 1: ship the boot script to the host. No secrets inside — it `read`s
# the password from its own stdin.
ssh -o BatchMode=yes "$HOST" 'cat > /root/.boot-redis-accessory.sh' <<'REMOTE'
#!/usr/bin/env bash
set -euo pipefail
NAME="inari-web-redis"

# Read the password the local side is about to pipe in.
read -r PASS

# Idempotent teardown.
docker rm -f "$NAME" >/dev/null 2>&1 || true

# Persistent data dir owned by redis (uid 999 in redis:7-alpine).
mkdir -p /var/lib/inari-web-redis
chown 999:999 /var/lib/inari-web-redis

# Run the accessory. Mirror web/config/deploy.yml accessories.redis exactly.
# --user 999:999 matches the redis user baked into the image; required
# because cap-drop ALL strips CAP_DAC_OVERRIDE, so even container-root
# can't write to a dir it doesn't own. /var/lib/inari-web-redis was just
# chowned to 999:999 on the host above.
docker run -d \
  --name "$NAME" \
  --restart always \
  --user 999:999 \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  -p 172.18.0.1:6379:6379 \
  -v /var/lib/inari-web-redis:/data \
  -e REDIS_PASSWORD="$PASS" \
  redis:7-alpine \
  sh -c 'exec redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru --requirepass "$REDIS_PASSWORD"' \
  >/dev/null

# Wait for the container to either become healthy or exit. Up to 10s.
# Fall through to log dump either way so we always have evidence.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  STATE="$(docker inspect -f '{{.State.Status}}' "$NAME" 2>/dev/null || echo gone)"
  case "$STATE" in
    running|exited|gone) break ;;
  esac
  sleep 1
done

echo "=== container state: $STATE ==="
echo "=== docker logs (last 40 lines) ==="
docker logs --tail 40 "$NAME" 2>&1 || true
echo "=== /var/lib/inari-web-redis ==="
ls -la /var/lib/inari-web-redis/ 2>&1 | head -10

if [ "$STATE" != "running" ]; then
  echo "fail: container not running after 10s (state=$STATE) — left in place for diagnosis" >&2
  exit 2
fi

# Auth wall check: unauthed PING must return NOAUTH.
PING_OUT="$(docker exec "$NAME" redis-cli PING 2>&1 || true)"
if ! grep -q NOAUTH <<< "$PING_OUT"; then
  echo "fail: requirepass not enforced — unauthed PING returned: $PING_OUT" >&2
  exit 3
fi

# Cross-network proof: connect as if we were the web container, this time
# WITH the password. Should return PONG.
AUTH_OUT="$(docker run --rm --network kamal -e PASS="$PASS" redis:7-alpine \
  sh -c 'redis-cli -h 172.18.0.1 -a "$PASS" --no-auth-warning PING' 2>&1 || true)"
if [ "$AUTH_OUT" != "PONG" ]; then
  echo "fail: authed PING from kamal network returned: $AUTH_OUT" >&2
  exit 4
fi

echo "ok: requirepass enforced + reachable from kamal network as PONG"
docker ps --filter "name=$NAME" --format "  {{.Names}}  {{.Status}}  {{.Ports}}"
REMOTE

# Stage 2: pipe the password to the remote script via ssh stdin. Then nuke
# the script (no secret in it, but no need to leave artifacts).
printf '%s\n' "$PASS" | ssh -o BatchMode=yes "$HOST" \
  'bash /root/.boot-redis-accessory.sh; rm -f /root/.boot-redis-accessory.sh'
