#!/bin/bash
#
# InariWatch k6 Stress Test Runner
#
# Usage:
#   ./run-all.sh                    # run all scenarios
#   ./run-all.sh webhook-storm      # run single scenario
#   ./run-all.sh --list             # list available scenarios
#
# Environment:
#   Export required vars or create a .env file in k6/ directory
#
#   export BASE_URL=https://app.inariwatch.com
#   export CRON_SECRET=your_secret
#   export API_TOKEN=inari_mcp_your_token
#   export INTEGRATION_ID=your_integration_uuid
#   export WEBHOOK_SECRET=your_webhook_secret
#   export CAPTURE_SECRET=your_capture_secret

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCENARIOS_DIR="$SCRIPT_DIR/scenarios"
RESULTS_DIR="$SCRIPT_DIR/results"

# Load .env if exists
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

# Create results directory
mkdir -p "$RESULTS_DIR"

SCENARIOS=(
  "webhook-storm"
  "mcp-rate-limits"
  "sse-streaming"
  "alert-dedup"
  "auth-bruteforce"
  "cron-fanout"
  "neon-saturation"
  "push-serialization"
  "auto-heal"
  "full-incident"
  "chaos-incident"
  "chaos-mcp-storm"
  "chaos-tenant-isolation"
  "chaos-sse"
  # Fase 12 Part B — chaos scenarios for VAR pipeline resilience
  "chaos-sandbox-cve"
  "chaos-pattern-poisoning"
  "chaos-community-fix-abuse"
  "chaos-model-regression"
  "chaos-tier-router-attack"
  "chaos-eap-chain-break"
  "chaos-worker-pool-starvation"
  "chaos-redis-partition"
  "chaos-substrate-corruption"
  "chaos-gate-parallel-race"
  "chaos-classifier-timeout"
)

# List mode
if [ "${1:-}" = "--list" ]; then
  echo "Available scenarios:"
  for s in "${SCENARIOS[@]}"; do
    echo "  - $s"
  done
  exit 0
fi

# Validate environment
if [ -z "${BASE_URL:-}" ]; then
  echo "ERROR: BASE_URL is not set. Export it or create k6/.env"
  exit 1
fi

run_scenario() {
  local name="$1"
  local file="$SCENARIOS_DIR/$name.js"
  local timestamp=$(date +%Y%m%d-%H%M%S)
  local output="$RESULTS_DIR/${name}_${timestamp}.json"

  if [ ! -f "$file" ]; then
    echo "ERROR: Scenario file not found: $file"
    return 1
  fi

  echo ""
  echo "════════════════════════════════════════════════════════════════"
  echo "  Running: $name"
  echo "  Target:  $BASE_URL"
  echo "  Output:  $output"
  echo "════════════════════════════════════════════════════════════════"
  echo ""

  k6 run \
    --out json="$output" \
    --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
    "$file"

  echo ""
  echo "  Completed: $name → $output"
  echo ""
}

# Run single scenario or all
if [ -n "${1:-}" ] && [ "$1" != "--list" ]; then
  run_scenario "$1"
else
  echo "InariWatch k6 Stress Test Suite"
  echo "Target: $BASE_URL"
  echo "Scenarios: ${#SCENARIOS[@]}"
  echo ""

  PASSED=0
  FAILED=0

  for scenario in "${SCENARIOS[@]}"; do
    if run_scenario "$scenario"; then
      PASSED=$((PASSED + 1))
    else
      FAILED=$((FAILED + 1))
      echo "  FAILED: $scenario"
    fi
  done

  echo ""
  echo "════════════════════════════════════════════════════════════════"
  echo "  Results: $PASSED passed, $FAILED failed out of ${#SCENARIOS[@]}"
  echo "  Reports: $RESULTS_DIR/"
  echo "════════════════════════════════════════════════════════════════"
fi
