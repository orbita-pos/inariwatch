#!/bin/sh
# Inari Live — pre-commit hook (non-blocking, fire-and-forget).
# Generated at install time; do not edit by hand. Restore with the
# `Uninstall git hooks` button in Inari Live Settings.

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
DIFF_SIZE="$(git diff --cached --shortstat 2>/dev/null | awk '{ for (i=1; i<=NF; i++) if ($i ~ /insertion|deletion/) sum += $(i-1) } END { print sum+0 }')"

PAYLOAD=$(printf '{"kind":"pre_commit","repo_id":"%s","ref":"%s","sha":"%s","diff_size":%s}' \
    "$REPO_ID" "$REF" "$SHA" "${DIFF_SIZE:-0}")

# Fire-and-forget: 1s timeout, never block the commit.
curl --silent --show-error --max-time 1 \
     --header "Authorization: Bearer $TOKEN" \
     --header 'Content-Type: application/json' \
     --data "$PAYLOAD" \
     "http://127.0.0.1:$PORT/sensors/git/event" >/dev/null 2>&1 || true

exit 0
