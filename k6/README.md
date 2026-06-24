# InariWatch k6 Stress Tests

10 scenarios that stress-test every layer of InariWatch infrastructure.

## Setup

```bash
# Install k6
# macOS: brew install k6
# Windows: choco install k6
# Linux: https://grafana.com/docs/k6/latest/set-up/install-k6/

# Configure environment
cp k6/config/staging.json k6/.env
# Edit .env with your test workspace credentials
```

## Environment Variables

```bash
export BASE_URL=https://app.inariwatch.com
export CRON_SECRET=<your-cron-secret>
export API_TOKEN=inari_mcp_<your-token>
export INTEGRATION_ID=<test-workspace-integration-uuid>
export WEBHOOK_SECRET=<webhook-hmac-secret>
export CAPTURE_SECRET=<capture-hmac-secret>
export SESSION_COOKIE=<nextauth-session-token>  # for SSE tests
```

## Run

```bash
# All 10 scenarios
./k6/run-all.sh

# Single scenario
./k6/run-all.sh webhook-storm

# List available
./k6/run-all.sh --list

# Direct k6 (with custom options)
k6 run k6/scenarios/webhook-storm.js
```

## Scenarios

| # | Scenario | What it tests | Duration |
|---|----------|--------------|----------|
| 1 | `webhook-storm` | 6 webhook types under burst load, rate limiting, dedup | 4 min |
| 2 | `mcp-rate-limits` | 3 MCP rate limit tiers (cheap/moderate/expensive) | 2 min |
| 3 | `sse-streaming` | 50 concurrent SSE connections, reconnection | 3 min |
| 4 | `alert-dedup` | Fingerprinting, dedup accuracy, storm detection | 4 min |
| 5 | `auth-bruteforce` | Login brute force protection, device flow rate limits | 1 min |
| 6 | `cron-fanout` | 7 sub-pollers in parallel, overlap handling | 4 min |
| 7 | `neon-saturation` | DB concurrency: webhooks + MCP + cron simultaneously | 2 min |
| 8 | `push-serialization` | Push notification pipeline under burst | 3 min |
| 9 | `auto-heal` | 3 failures → auto-heal, cooldown, race conditions | 5 min |
| 10 | `full-incident` | Complete incident lifecycle end-to-end | 5 min |

## Results

Results are saved to `k6/results/` as JSON files. View with:

```bash
# k6 built-in summary (printed after each run)
# Or use k6 Cloud for dashboards: k6 cloud run k6/scenarios/webhook-storm.js
```

## Safety

- All tests target a **test workspace** in production, not real user data
- Webhook tests use HMAC signatures — invalid signatures are rejected
- Rate limit tests deliberately exceed limits — expect 429 responses
- Auto-heal test triggers uptime cron but won't rollback unless monitors are configured with `autoHeal: true`
- Full-incident test creates real alerts in the test workspace — clean up after
