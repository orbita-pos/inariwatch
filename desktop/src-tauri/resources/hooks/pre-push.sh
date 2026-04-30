#!/bin/sh
# Inari Live — pre-push hook. BLOCKS waiting for the daemon's gate
# verdict. Exits 1 to abort the push when allow=false. Set
# INARI_BYPASS=1 to skip (escape hatch). Fail-open on daemon
# unreachable / timeout so a stopped daemon doesn't strand the user.

set -e
[ "${INARI_BYPASS:-0}" = "1" ] && exit 0

PORT_FILE='__INARI_PORT_FILE__'
TOKEN='__INARI_HOOK_TOKEN__'
REPO_ID='__INARI_REPO_ID__'

[ -r "$PORT_FILE" ] || exit 0
PORT="$(tr -d '[:space:]' < "$PORT_FILE")"
[ -n "$PORT" ] || exit 0

REF="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || echo HEAD)"
SHA="$(git rev-parse HEAD 2>/dev/null || echo '')"
DIFF_SIZE="$(git diff --shortstat 2>/dev/null | awk '{ for (i=1; i<=NF; i++) if ($i ~ /insertion|deletion/) sum += $(i-1) } END { print sum+0 }')"

PAYLOAD=$(printf '{"kind":"pre_push","repo_id":"%s","ref":"%s","sha":"%s","diff_size":%s}' \
    "$REPO_ID" "$REF" "$SHA" "${DIFF_SIZE:-0}")

# Synchronous; capture body and HTTP status. 30s budget covers the gate
# runner (Session 20 will parallelise with tokio::join!).
RESPONSE_FILE="$(mktemp 2>/dev/null || echo /tmp/inari_pre_push_$$)"
HTTP_STATUS=$(curl --silent --show-error --max-time 30 \
                  --output "$RESPONSE_FILE" --write-out '%{http_code}' \
                  --header "Authorization: Bearer $TOKEN" \
                  --header 'Content-Type: application/json' \
                  --data "$PAYLOAD" \
                  "http://127.0.0.1:$PORT/sensors/git/event" 2>/dev/null) || HTTP_STATUS=000

if [ "$HTTP_STATUS" = "000" ] || [ -z "$HTTP_STATUS" ]; then
    # Daemon unreachable / timed out. Fail-open per Session-8 decision:
    # a stopped daemon must not block legitimate pushes.
    rm -f "$RESPONSE_FILE"
    exit 0
fi

ALLOW=$(awk -F'"allow":' '{ print $2 }' "$RESPONSE_FILE" 2>/dev/null \
        | awk -F'[,}]' '{ gsub(/[ \t]/, "", $1); print $1 }')
if [ "$ALLOW" = "true" ]; then
    rm -f "$RESPONSE_FILE"
    exit 0
fi

REASON=$(awk -F'"reason":"' '{ print $2 }' "$RESPONSE_FILE" 2>/dev/null \
         | awk -F'"' '{ print $1 }')
echo "Inari Live blocked the push: ${REASON:-gate denied}" >&2
echo "Re-run with INARI_BYPASS=1 git push to override." >&2
rm -f "$RESPONSE_FILE"
exit 1
