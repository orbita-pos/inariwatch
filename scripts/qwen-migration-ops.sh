#!/usr/bin/env bash
# Qwen migration — 5 manual ops to run before flipping the flag in prod.
#
# Run from your workstation (not from CI). Requires:
#   - SSH agent loaded with HETZNER_DEPLOY_KEY (ssh-add)
#   - PLATFORM_TOGETHER_KEY in shell env (decrypted from sops)
#   - kamal CLI installed (gem install kamal -v 2)
#   - jq + curl on PATH

set -euo pipefail

WEB_HOST="87.99.153.227"           # CPX21 Ashburn (inari-web)
SIDECAR_HOST="178.105.21.94"       # Falkenstein (inari-ml)

echo "═══ Qwen migration — 5 ops ═══════════════════════════════════════"

# ── 1. chown TRANSFORMERS_CACHE host dir to UID 1001 (nextjs user) ──────────
echo
echo "[1/5] chown /var/lib/inari-transformers-cache → 1001:1001 on web host"
ssh "root@${WEB_HOST}" '
  if [ ! -d /var/lib/inari-transformers-cache ]; then
    mkdir -p /var/lib/inari-transformers-cache
  fi
  chown -R 1001:1001 /var/lib/inari-transformers-cache
  ls -ld /var/lib/inari-transformers-cache
'

# ── 2. Verify Qwen IDs against Together's real serverless catalog ───────────
echo
echo "[2/5] Verifying Qwen IDs against Together /v1/models"
if [ -z "${PLATFORM_TOGETHER_KEY:-}" ]; then
  echo "  ⚠ PLATFORM_TOGETHER_KEY not set in env — decrypt from sops first:"
  echo "    sops -d web/.env.sops.yaml | grep PLATFORM_TOGETHER_KEY"
  exit 1
fi

curl -fsS https://api.together.xyz/v1/models \
  -H "Authorization: Bearer ${PLATFORM_TOGETHER_KEY}" \
  | jq -r '.[] | .id' \
  | grep -E "Qwen3\\.6-Plus|Qwen3-235B-A22B-Instruct-2507|Qwen3-Coder-Next|Qwen3\\.5-9B" \
  | sort -u

echo
echo "  Expected (all 4 must appear):"
echo "    Qwen/Qwen3.5-9B-FP8"
echo "    Qwen/Qwen3-Coder-Next-FP8"
echo "    Qwen/Qwen3-235B-A22B-Instruct-2507-tput"
echo "    Qwen/Qwen3.6-Plus"
echo
echo "  If any slug differs (e.g., capitalization), update web/lib/ai/together-routing.ts."

# ── 3. Smoke test thinking-mode payload against Qwen3-235B ──────────────────
echo
echo "[3/5] Smoke test: thinking-mode wire format against Qwen3-235B"
RESPONSE=$(curl -fsS https://api.together.xyz/v1/chat/completions \
  -H "Authorization: Bearer ${PLATFORM_TOGETHER_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen/Qwen3-235B-A22B-Instruct-2507-tput",
    "chat_template_kwargs": { "enable_thinking": true },
    "max_tokens": 200,
    "messages": [{ "role": "user", "content": "What is 2+2? Reason step by step." }]
  }')

# Together echoes back the model + usage. If thinking-mode is honored, we
# typically see <think>...</think> blocks in the content or a different
# reasoning shape. The CRITICAL check is: did the request succeed (no 400)?
echo "  Response model: $(echo "$RESPONSE" | jq -r '.model')"
echo "  Tokens used:    $(echo "$RESPONSE" | jq -r '.usage.total_tokens')"
echo "  Content (first 200 chars):"
echo "$RESPONSE" | jq -r '.choices[0].message.content' | head -c 200
echo
echo "  ⓘ If you see <think> tags or extended reasoning, thinking-mode is on."

# ── 4. kamal env push (TRANSFORMERS_CACHE value changed) ────────────────────
echo
echo "[4/5] kamal env push (TRANSFORMERS_CACHE updated from /root → /app)"
cd web
kamal env push
cd ..
echo "  ✓ env pushed"

# ── 5. scp ml-sidecar/main.py + docker restart ──────────────────────────────
echo
echo "[5/5] Update ml-sidecar on Falkenstein"
scp ml-sidecar/main.py "root@${SIDECAR_HOST}:/opt/inari-ml/main.py"
ssh "root@${SIDECAR_HOST}" '
  cd /opt/inari-ml
  # Verify the new SCHEMA_VERSION=2 sentinel forces a fresh model rebuild
  # (old pickle from v0.4.0 will be discarded on first request)
  docker restart inari-ml
  sleep 3
  curl -sS http://localhost:9410/health | jq .
'
echo "  ✓ sidecar restarted — check schema_version=2 in /health output"

echo
echo "═══ Done ═════════════════════════════════════════════════════════"
echo "Next: kamal deploy (web) to pick up the new TRANSFORMERS_CACHE mount."
echo "After deploy stabilizes, flip the flag:"
echo "  Already on:  INARI_TOGETHER_PLATFORM_FUNDED_ENABLED=true (deploy.yml)"
echo "Watch /admin/ai for the first 30 min — confirm fix path actually routes"
echo "to Qwen3.6-Plus (not GPT-5.4 fallback)."
