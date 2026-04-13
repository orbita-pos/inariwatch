# Worker Deployment Guide

## Prerequisites

- Hetzner server with Go staging server + Redis running
- Node.js 20+ installed
- `DATABASE_URL`, `CRON_SECRET`, `STAGING_API_SECRET` in `.env`
- `APP_URL` pointing to `https://app.inariwatch.com`

## Deploy Steps

### 1. Install & Build

```bash
cd /opt/inariwatch/worker
git pull
npm install
npm run build
```

### 2. Run Migration

```bash
# From local machine or Hetzner (needs DATABASE_URL)
psql $DATABASE_URL -f web/lib/db/migrations/0045_alert_hourly_counts.sql
```

### 3. Update Worker Service

```bash
sudo systemctl restart inari-worker
```

### 4. Verify Worker is Running

```bash
# Check logs
journalctl -u inari-worker --since "1 min ago"

# Should see:
# [critical-worker] Started (concurrency: 10)
# [default-worker] Started (concurrency: 5)
# [low-worker] Started (concurrency: 3)
# [scheduler] Repeatable jobs registered
# InariWatch Worker listening on port 9401

# Check queue stats
curl -s -H "Authorization: Bearer $STAGING_API_SECRET" \
  http://localhost:9401/worker/queues | jq
```

### 5. Disable Go Cron Jobs

Edit the Go scheduler config to remove jobs now handled by BullMQ:

| Job | Action | Reason |
|-----|--------|--------|
| `uptime` | **REMOVE** | Worker `uptime-check` job (60s) |
| `escalate` | **REMOVE** | Worker `escalate-alert` (event-driven) + `escalation-sweep` (5min fallback) |
| `deploy-monitor` | **REMOVE** | Worker `deploy-monitor` (event-driven) + sweep (2min) |
| `digest` | **REMOVE** | Worker `digest` job (1hr) |
| `poll` | **KEEP but reduce to 10min** | Fallback only — worker `poll-integrations` handles npm/postgres/expo every 2min |

```bash
# After updating Go config:
sudo systemctl restart inari-staging
```

### 6. Delete cron-job.org Jobs

Log into cron-job.org and delete ALL remaining jobs. They are fully replaced.

### 7. Verify End-to-End

```bash
# Check uptime checks are running
journalctl -u inari-worker --since "2 min ago" | grep uptime

# Check poll is working
journalctl -u inari-worker --since "3 min ago" | grep poll

# Check notifications are flushing
journalctl -u inari-worker --since "1 min ago" | grep notifications

# Verify Neon is no longer getting hit every minute
# (check Neon dashboard — compute should show gaps between queries)
```

## Environment Variables

Add to `/opt/inariwatch/worker/.env`:

```env
DATABASE_URL=<neon-connection-string>
STAGING_API_SECRET=<same-as-go-server>
CRON_SECRET=<same-as-vercel>
APP_URL=https://app.inariwatch.com
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
WORKER_PORT=9401
MAX_CONCURRENT_JOBS=2
```

## Architecture After Deploy

```
Before:
  Go cron → HTTP → Vercel → Neon (every 1-2 min, always)

After:
  Worker (BullMQ) → direct DB or → Vercel endpoint (only when needed)
  Neon can scale-to-zero between poll cycles (every 2 min gap)
```

## Rollback

If something breaks:
1. Re-enable Go cron jobs (restore old config)
2. Restart Go server: `sudo systemctl restart inari-staging`
3. Worker jobs will run in parallel with Go crons — no conflict (dedup prevents duplicates)
