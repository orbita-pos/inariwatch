-- VAR Q2 — Gate 12 "What-If Across Fleet"
--
-- Extends the Q1 single-session What-If into a batched replay against the
-- top N affected sessions for an alert's fingerprint. Powers:
--
--   - UI: "Fleet Verification" card on the alert detail page showing
--     `{matched}/{total}` sessions protected by the fix.
--   - Auto-merge Gate 12: `fleetVerification.matchedPercent >= 90`
--     required before autonomous-mode merges.
--
-- Shape:
--   ┌──────────────────────────────────────────────────────────┐
--   │ fleet_verification_runs (one row per alert+remediation)  │
--   └──────────────────────────────────────────────────────────┘
--
-- Lifecycle:
--   1. Web POST /api/alerts/:id/fleet-verify  → INSERT row, enqueue
--      `fleet-verification` BullMQ job on `low` queue
--   2. Worker picks it up, queries top N sessions, loops calling
--      runWhatIf() internally with concurrency=2 (matches whatif cap),
--      updates progress columns after each session
--   3. Client polls GET /api/alerts/:id/fleet-verify every 2s while
--      status='running', renders final aggregate when 'completed'
--
-- Idempotency:
--   UNIQUE (alert_id, remediation_id, fix_commit_sha) — re-fetching
--   the same fix re-reads the existing row; only re-enqueues when the
--   previous run failed.
--
-- Reverse:
--   DROP TABLE IF EXISTS fleet_verification_runs;

CREATE TABLE IF NOT EXISTS fleet_verification_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id            uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  remediation_id      uuid NOT NULL REFERENCES remediation_sessions(id) ON DELETE CASCADE,
  fix_commit_sha      text NOT NULL,
  fingerprint         text NOT NULL,
  -- Worker id captured at enqueue time so we can surface a status even if
  -- the job is evicted from BullMQ before finishing.
  bullmq_job_id       text,

  -- Progress counters — updated in place by the worker as each session
  -- finishes. `sessions_total` is frozen at enqueue time (= number of
  -- siblings we're about to check); progress = attempted/total.
  status              text NOT NULL DEFAULT 'running',
  sessions_total      integer NOT NULL,
  sessions_attempted  integer NOT NULL DEFAULT 0,

  -- Per-outcome counts — denormalized from session_results for cheap
  -- `SELECT` on the card without parsing JSONB.
  count_matched           integer NOT NULL DEFAULT 0,
  count_uncertain         integer NOT NULL DEFAULT 0,
  count_would_not_prevent integer NOT NULL DEFAULT 0,
  count_errored           integer NOT NULL DEFAULT 0,

  -- Detailed per-session outcomes. Shape:
  --   [{ sessionId, outcome, riskScore?, errorCode?, durationMs }]
  -- Capped at sessions_total items. Used by the "view failing sessions"
  -- modal; the card itself only reads the count_* columns.
  session_results     jsonb NOT NULL DEFAULT '[]'::jsonb,

  started_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  error               text,

  -- One verification row per (alert, fix). Subsequent fixes for the same
  -- alert (different SHA) create new rows; old ones stay as history.
  CONSTRAINT fleet_verification_runs_unique_per_fix
    UNIQUE (alert_id, remediation_id, fix_commit_sha)
);

-- Cover hot queries: "latest verification for alert X" on the card path,
-- and "all running jobs" for an admin progress view.
CREATE INDEX IF NOT EXISTS fleet_verification_runs_alert_idx
  ON fleet_verification_runs (alert_id, started_at DESC);

CREATE INDEX IF NOT EXISTS fleet_verification_runs_running_idx
  ON fleet_verification_runs (status)
  WHERE status = 'running';

COMMENT ON TABLE fleet_verification_runs IS
  'VAR Gate 12. Aggregate What-If replay across the top N sessions sharing an alert fingerprint. Powers fleet-level merge gates and the X/Y sessions protected UI. One row per (alert, remediation, fix_commit_sha). The worker updates counters in place.';

COMMENT ON COLUMN fleet_verification_runs.status IS
  'running, completed, or failed. The worker flips to completed/failed on its last iteration.';

COMMENT ON COLUMN fleet_verification_runs.session_results IS
  'Array of session result objects. Capped at sessions_total elements. Used by the drill-down modal. The card summary reads count_* columns for speed.';
