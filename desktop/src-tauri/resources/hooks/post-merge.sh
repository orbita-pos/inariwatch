#!/bin/sh
# Inari Live — post-merge hook. Fires after `git merge`, `git pull`, or
# `git rebase --continue` lands new commits. Triggers the indexer to
# re-walk the repo (via DaemonEvent::ReindexRequested). Non-blocking.

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

PAYLOAD=$(printf '{"kind":"post_merge","repo_id":"%s","ref":"%s","sha":"%s","diff_size":0}' \
    "$REPO_ID" "$REF" "$SHA")

curl --silent --show-error --max-time 1 \
     --header "Authorization: Bearer $TOKEN" \
     --header 'Content-Type: application/json' \
     --data "$PAYLOAD" \
     "http://127.0.0.1:$PORT/sensors/git/event" >/dev/null 2>&1 || true

exit 0
