# Configuration Reference

## Auto-Merge Settings

Configure in **Project Settings > Auto-Merge**.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable auto-merge for this project |
| `minConfidence` | number | `90` | Minimum AI confidence to auto-merge (overridden by trust level) |
| `maxLinesChanged` | number | `50` | Maximum lines the fix can change (overridden by trust level) |
| `requireSelfReview` | boolean | `true` | Require AI self-review score >= 70 |
| `postMergeMonitor` | boolean | `true` | Watch for regressions after merge |
| `autoRevert` | boolean | `true` | Auto-revert if regression detected |
| `autoRemediate` | boolean | `false` | Auto-trigger remediation on critical alerts |
| `autoHeal` | boolean | `false` | Rollback + remediate when uptime detects site down |

## AI Provider

Configure in **Settings > AI Analysis**.

| Setting | Description |
|---------|-------------|
| API Key | Your key for Claude, OpenAI, Grok, Gemini, Groq, or DeepSeek |
| Active Provider | Which provider to use (auto-detected from key prefix) |
| Model Preferences | Override default model per task (analysis, chat, remediation, postmortem) |

## Environment Variables

Set in your deployment platform (Vercel, etc.):

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | Neon PostgreSQL connection string |
| `NEXTAUTH_SECRET` | Yes | Session encryption key |
| `NEXTAUTH_URL` | Yes | App URL (e.g., `https://app.inariwatch.com`) |
| `ENCRYPTION_KEY` | Yes | Encrypts API keys stored in DB |
| `CRON_SECRET` | Yes | Authenticates external cron triggers |
| `PLATFORM_AI_KEY` | No | Platform GPT-4o-mini key for free auto-analysis |
| `STAGING_SERVER_URL` | No | Staging server URL (enables staging gate) |
| `STAGING_API_SECRET` | No | Staging server auth secret |
| `EAP_SERVER_URL` | No | EAP verification server (enables EAP gate) |
| `RESEND_API_KEY` | No | Email notifications via Resend |
| `SLACK_CLIENT_ID` / `SECRET` / `SIGNING_SECRET` | No | Slack bot integration |
| `TELEGRAM_WEBHOOK_SECRET` | No | Telegram bot webhook verification |

## Limits

| Limit | Default | Description |
|-------|---------|-------------|
| Max concurrent remediations per project | 3 | Additional sessions are queued |
| Max concurrent remediations global | 10 | Across all projects |
| CI wait timeout | 5 min | Max time waiting for CI checks |
| Staging TTL | 5 min | Staging container auto-destroyed |
| Post-merge monitoring | 10 min | Regression watch window |
| Max fix attempts | 3 | CI retry limit per session |
| Max files to read | 5 | Per diagnosis |
| File content truncation | 10,000 chars | Per file sent to AI |

## Concurrency & Locking

| Setting | Default | Configurable |
|---------|---------|-------------|
| Max concurrent per project | 3 | No |
| Max concurrent global | 10 | No |
| File lock TTL | 10 min | No |
| File lock wait timeout | 30 sec | No |

## Canary Monitoring Phases

| Phase | Duration | Check Interval | Configurable |
|-------|----------|---------------|-------------|
| canary_fast | 0–3 min | 30s | No |
| canary_normal | 3–7 min | 60s | No |
| canary_slow | 7–10 min | 120s | No |

## Incident Correlation

| Setting | Default | Configurable |
|---------|---------|-------------|
| Time window for grouping | 5 min | No |
| File overlap threshold | 50% | No |
| Leader wait timeout | 5 min | No |

## Anti-Pattern Learning

| Setting | Default | Configurable |
|---------|---------|-------------|
| Max anti-patterns injected | 3 | No |
| Lookup strategy | Fingerprint match → file overlap fallback | No |
| Confidence calibration minimum | 10 data points | No |

## Trust Level Overrides

Trust levels are computed automatically. You cannot manually set a trust level, but you can configure thresholds that are stricter than what the trust level allows. The bot always uses the stricter of your setting vs the trust level requirement.
