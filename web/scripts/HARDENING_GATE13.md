# Gate 13 — Hardening procedure

End-to-end validation on Hetzner production. Smoke tests already proved
the SQL + scoring against Neon (`smoke-test-drift.ts`, `smoke-test-extract.ts`
— both green). This is the **deploy + live enqueue** pass.

Pre-req: smoke tests green + seed already applied to Neon.

---

## 1 · Commit + push worker changes

From the monorepo root:

```bash
git add worker/src/db.ts \
        worker/src/jobs/substrate-extract.ts \
        worker/src/jobs/behavioral-drift.ts \
        worker/src/workers/low.worker.ts \
        worker/src/server.ts
git add web/lib/db/migrations/0060_behavioral_drift.sql \
        web/lib/db/schema.ts \
        web/lib/ai/auto-merge-gates.ts \
        web/lib/ai/__tests__/auto-merge-gates.test.ts \
        web/lib/services/behavioral-drift.service.ts \
        web/app/api/alerts/\[id\]/drift-analysis/route.ts \
        web/app/api/recordings/upload/route.ts \
        'web/app/(dashboard)/alerts/[id]/behavioral-drift-card.tsx' \
        'web/app/(dashboard)/alerts/[id]/page.tsx'
git add web/scripts/run-migration-0060.ts \
        web/scripts/seed-drift-demo.ts \
        web/scripts/smoke-test-drift.ts \
        web/scripts/smoke-test-extract.ts \
        web/scripts/HARDENING_GATE13.md \
        web/scripts/verify-drift-demo.ts

git commit -m "feat(var): Q2 Week 5 — Gate 13 Behavioral Drift"
git push origin main
```

---

## 2 · Deploy worker to Hetzner

```bash
ssh inari-staging
deploy-worker
```

The script does: `cd /opt/inariwatch && git pull` → rsync `worker/src/`
→ `npm ci` → `systemctl restart inari-worker` → tail `journalctl`.

Confirm in the printed journalctl lines:

- `[low-worker] Started (concurrency: 3)`
- No `Unknown job` warnings on startup

If `npm ci` fails with lockfile out-of-sync, regenerate locally
(`cd worker && npm install`) and push the updated `package-lock.json`.

---

## 3 · Live enqueue — behavioral-drift job

The web app seeded a `behavioral_drift_runs` row with `status='completed'`.
To force the worker to actually compute it, reset the row first.

From your laptop with `DATABASE_URL` exported:

```bash
cd web
export DATABASE_URL=$(grep '^DATABASE_URL' .env.local | cut -d'=' -f2- | tr -d '"')

# Reset the run so the worker processes it
node -e "
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
(async () => {
  const [run] = await sql\`
    SELECT id FROM behavioral_drift_runs
    WHERE alert_id = 'd0e9e62e-b08e-4dd8-89ca-08ab142019ee'::uuid
  \`;
  await sql\`
    UPDATE behavioral_drift_runs SET status='running', passed=NULL,
      analyzed_endpoints=0, drifted_endpoints=0, improved_endpoints=0,
      insufficient_data_endpoints=0, max_drift_score=NULL,
      endpoint_details='[]'::jsonb, improvements_detected='[]'::jsonb,
      completed_at=NULL, error=NULL
    WHERE id=\${run.id}::uuid
  \`;
  console.log('reset run', run.id);
})();
"
```

Then inject fake fleet replays so the worker has fix-side events to score
against (no real remediation ran for this seed). On Hetzner (or from
your laptop with access to the same DB):

```bash
# Insert 8 whatif_replays rows with fix event streams. See
# smoke-test-drift.ts buildFleetReplays() for the shape.
# Copy its logic or reuse the script with --live flag if extended.
```

> Shortcut: rerun `npx tsx scripts/smoke-test-drift.ts` — it injects
> the replays, computes the drift locally, and cleans up. For a true
> worker-side compute, keep the whatif_replays rows in place, then
> trigger the worker (next step).

Enqueue the job via the worker's HTTP endpoint:

```bash
export WORKER_URL=https://<your-worker-url>   # or https://worker.inariwatch.com
export STAGING_API_SECRET=<from-hetzner-.env>

RUN_ID=$(node -e "
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
(async () => {
  const [r] = await sql\`
    SELECT id FROM behavioral_drift_runs
    WHERE alert_id='d0e9e62e-b08e-4dd8-89ca-08ab142019ee'::uuid
  \`;
  console.log(r.id);
})();
")

curl -fsS -X POST "$WORKER_URL/worker/enqueue" \
  -H "Authorization: Bearer $STAGING_API_SECRET" \
  -H "Content-Type: application/json" \
  -d "{\"queue\":\"low\",\"name\":\"behavioral-drift\",\"data\":{\"runId\":\"$RUN_ID\"}}"
```

Watch worker logs:

```bash
ssh inari-staging 'sudo journalctl -u inari-worker -f -n 50'
```

Expect a line like:

```
[drift] <runId>: analyzed=1 drifted=1 improved=0 insuf=0 max=0.504 passed=false
```

---

## 4 · Verify the DB row

```bash
node -e "
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
(async () => {
  const rows = await sql\`
    SELECT status, passed, analyzed_endpoints, drifted_endpoints,
           max_drift_score,
           jsonb_array_length(endpoint_details) AS detail_count
    FROM behavioral_drift_runs
    WHERE alert_id='d0e9e62e-b08e-4dd8-89ca-08ab142019ee'::uuid
  \`;
  console.log(rows[0]);
})();
"
```

Pass criteria:

- `status='completed'`
- `analyzed_endpoints=1`
- `drifted_endpoints=1`
- `max_drift_score > 0.4`
- `detail_count=1`

---

## 5 · Restore the demo

The smoke test / live enqueue path leaves the drift run with real-computed
data (single drifted endpoint, no improvements). To restore the rich
demo UI (improvements card visible):

```bash
cd web
export DATABASE_URL=$(grep '^DATABASE_URL' .env.local | cut -d'=' -f2- | tr -d '"')
npx tsx scripts/seed-drift-demo.ts --email bernal.rojas.dev@gmail.com
```

---

## 6 · Substrate-extract live validation (optional)

Harder to trigger manually since it fires from `/api/recordings/upload`.
Cleanest path: use the CLI to upload a real substrate recording against
the Drift Demo project.

```bash
# From any Node.js app with @inariwatch/capture + substrate enabled:
INARIWATCH_PROJECT_ID=80fce652-7de4-40b1-a0d5-f3cc6e828f64 \
INARIWATCH_DSN=<your-dsn> \
node --import @inariwatch/capture/auto your-app.js
```

Then verify a `session_endpoint_metrics` row appeared:

```sql
SELECT endpoint_signature, latency_ms, db_query_count, healthy
FROM session_endpoint_metrics
WHERE project_id='80fce652-7de4-40b1-a0d5-f3cc6e828f64'::uuid
  AND captured_at > now() - interval '1 hour'
ORDER BY created_at DESC LIMIT 5;
```

If no row appears after ~30s, check:

1. Worker logs for `[substrate-extract]` lines
2. `ALLOWED_JOBS.low` on Hetzner matches the deployed server.ts
3. The SDK upload succeeded (`POST /api/recordings/upload` → 200)
4. The upload route's `projectId` + `events` were non-null (the gate
   feeder skips recordings missing either)

---

## Rollback

If Gate 13 breaks something unexpected:

```bash
ssh inari-staging
cd /opt/inariwatch
git log --oneline -5
git reset --hard <prev-commit>
deploy-worker
```

The migration is additive — tables can stay in Neon even after rollback;
they do no harm if no code writes to them.
