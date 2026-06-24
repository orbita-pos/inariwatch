-- VAR Q2 Week 5 — Gate 13 "Behavioral Drift"
--
-- Detects when a remediation pushes an endpoint's I/O behaviour away from
-- its historical norm. Unlike Gate 17 (same-session latency diff) this
-- gate compares the fix's replay against a 7-day rolling baseline of
-- HEALTHY production recordings, not the broken session that triggered
-- the fix. It is a yellow light — a fix that improves behaviour (fewer
-- queries, lower 5xx) is surfaced separately in improvements_detected
-- and does NOT fail the gate.
--
-- Two-tier shape:
--   session_endpoint_metrics — one row per healthy (recording, endpoint),
--     written by the substrate-extract BullMQ job after
--     /api/recordings/upload persists a new substrate_recordings row.
--   behavioral_drift_runs — one row per (alert, remediation, fix sha),
--     populated by the behavioral-drift BullMQ job on the low queue.
--
-- Why this shape (not a cron rollup):
--   A daily cron walking raw events is wasted work. We piggy-back on
--   recordings/upload to extract once, store per-endpoint rows in
--   Postgres, and query percentile_cont at gate time directly.
--
-- Why substrate_recordings (not replay_sessions):
--   Pure-backend Node.js apps record to substrate_recordings WITHOUT an
--   accompanying replay_session. Hooking replay-analyze would lose those
--   recordings. substrate_recordings.events JSONB is the primary source
--   of truth for server-side I/O.
--
-- Baseline query at gate time (pseudo, commas-only, no statement ends):
--     percentile_cont(0.5)  WITHIN GROUP (ORDER BY latency_ms)
--   , percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
--   , percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms)
--   , count(*) AS sample_count
--   FROM session_endpoint_metrics
--   WHERE project_id = $1
--     AND endpoint_signature = $2
--     AND captured_at > now() - (window_days || ' days')::interval
--     AND healthy = TRUE
--
-- Drift scoring (permissive calibration):
--   Structural — set-diff on downstream signatures, status-category shift
--   Magnitude  — |baseline.pX - fix.pX| / baseline.pX per metric
--   Per endpoint we store magnitude_score [0,1] and has_structural_drift
--   An endpoint counts as drifted when magnitude_score > 0.3 OR
--     has_structural_drift is true
--   Gate passes when drifted / analyzed <= threshold_drifted_percent (20)
--   Endpoints with under 50 baseline samples are insufficient_data,
--     skipped (neither pass nor fail — same as Gate 17 null handling)
--   max_drift_score reflects magnitude ONLY — structural does not push it
--
-- Retention:
--   session_endpoint_metrics rolls 30 days, pruned by a follow-up
--   retention worker (not included in this migration).
--
-- Reverse:
--   DROP TABLE IF EXISTS behavioral_drift_runs
--   DROP TABLE IF EXISTS session_endpoint_metrics

-- ── Tier 1 raw per-(recording, endpoint) samples ────────────────────────

CREATE TABLE IF NOT EXISTS session_endpoint_metrics (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- FK to the recording that produced this row. Primary source of truth
  -- is substrate_recordings — pure-backend captures (no browser rrweb)
  -- still land there. project_id is denormalized for the baseline query
  -- hot path so it does not need a join.
  substrate_recording_id  uuid NOT NULL REFERENCES substrate_recordings(id) ON DELETE CASCADE,
  project_id              uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Endpoint identity. endpoint_signature is the normalized form we
  -- group by (example POST /api/users/:id). endpoint_url_raw is the
  -- first URL observed, kept only for debugging. When framework route
  -- template is available from correlationData it takes precedence
  -- over the heuristic normalizer.
  endpoint_signature      text NOT NULL,
  endpoint_url_raw        text,

  -- Recording start time. Drives the rolling-window baseline query —
  -- "last 7d" means last 168h from now.
  captured_at             timestamptz NOT NULL,

  -- Is this recording free of captured errors? Derived at extract time
  -- from (substrate_recordings.alert_id IS NULL) plus absence of any
  -- error-kind events in the stream. Baseline reads filter
  -- WHERE healthy = TRUE. Unhealthy rows remain for future
  -- trend-delta work.
  healthy                 boolean NOT NULL DEFAULT TRUE,

  -- Metrics extracted from the substrate event stream scoped to this
  -- endpoint's inbound http_request lifecycle.
  latency_ms              double precision,
  db_query_count          integer NOT NULL DEFAULT 0,
  external_http_count     integer NOT NULL DEFAULT 0,
  top_status              integer,

  -- Set (deduped, sorted) of downstream signatures this endpoint called.
  -- Shape example ["postgres:SELECT users", "api.stripe.com/v1/charges"]
  -- Used for structural drift detection (set-diff against fix replay).
  downstream_signatures   jsonb NOT NULL DEFAULT '[]'::jsonb,

  created_at              timestamptz NOT NULL DEFAULT now(),

  -- One row per (recording, endpoint). Repeat hits to the same route
  -- inside one recording accumulate into a single row at extract time.
  CONSTRAINT session_endpoint_metrics_unique
    UNIQUE (substrate_recording_id, endpoint_signature)
);

-- Hot path — baseline percentile query for one endpoint over a time
-- window. Partial index keeps only healthy rows so baseline reads
-- never scan unhealthy.
CREATE INDEX IF NOT EXISTS session_endpoint_metrics_baseline_idx
  ON session_endpoint_metrics (project_id, endpoint_signature, captured_at DESC)
  WHERE healthy = TRUE;

-- Retention scan — rows older than 30 days, pruned by a follow-up
-- retention worker.
CREATE INDEX IF NOT EXISTS session_endpoint_metrics_captured_at_idx
  ON session_endpoint_metrics (captured_at);

COMMENT ON TABLE session_endpoint_metrics IS
  'VAR Gate 13 raw baseline samples. One row per (substrate_recording, endpoint_signature), written by the substrate-extract worker after /api/recordings/upload persists a recording. Baseline percentiles are computed with percentile_cont over a rolling N-day window of healthy=TRUE rows.';

COMMENT ON COLUMN session_endpoint_metrics.endpoint_signature IS
  'Normalized route signature (method plus path with :id placeholders). Heuristic normalizer replaces UUIDs and all-digit segments. When framework route template is available from correlationData it takes precedence. Stays stable across raw URL variations so percentile aggregation is meaningful.';

COMMENT ON COLUMN session_endpoint_metrics.healthy IS
  'TRUE when the source substrate_recording has alert_id NULL and no error-kind events. Gate 13 baseline reads only healthy rows. Unhealthy rows are retained for future trend analysis but never contribute to the baseline.';

COMMENT ON COLUMN session_endpoint_metrics.downstream_signatures IS
  'Deduped, sorted array of signatures this endpoint called. Format postgres:VERB-TABLE for db_query kinds, full URL for external http_request kinds. Used for structural drift detection (set-diff against fix replay).';

-- ── Tier 2 one row per gate run ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS behavioral_drift_runs (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id                    uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  remediation_id              uuid NOT NULL REFERENCES remediation_sessions(id) ON DELETE CASCADE,
  fix_commit_sha              text NOT NULL,
  bullmq_job_id               text,

  -- Rolling window (days) used to build the baseline for THIS run.
  -- Default 7, stored on the row so a threshold change or window bump
  -- is reproducible after the fact without recomputing.
  window_days                 integer NOT NULL DEFAULT 7,

  status                      text NOT NULL DEFAULT 'running',

  -- Summary counters.
  --   analyzed = endpoints the fix replay touched that ALSO had a
  --     usable baseline
  --   insufficient_data = touched endpoints whose baseline had under 50
  --     samples (skipped — neither pass nor fail)
  --   drifted = analyzed endpoints flagged for EITHER magnitude OR
  --     structural reasons (permissive calibration)
  --   improved = analyzed endpoints whose fix was directionally better
  --     than baseline (never fails the gate, yellow-light semantics)
  analyzed_endpoints          integer NOT NULL DEFAULT 0,
  insufficient_data_endpoints integer NOT NULL DEFAULT 0,
  drifted_endpoints           integer NOT NULL DEFAULT 0,
  improved_endpoints          integer NOT NULL DEFAULT 0,

  -- Worst per-endpoint MAGNITUDE score across analyzed endpoints,
  -- range [0,1]. Structural drift does NOT push this value (permissive
  -- calibration) — structural appears per-endpoint via
  -- has_structural_drift inside endpoint_details. Null when analyzed=0.
  max_drift_score             double precision,

  -- Per-endpoint drift detail for flagged endpoints only. Shape:
  --   [{
  --     signature, magnitudeScore, hasStructuralDrift,
  --     baselineSamples, fixSamples,
  --     structural: { missingDownstreams: [], newDownstreams: [],
  --                   statusShift: { baseline5xx, fix5xx } | null },
  --     magnitude: { latencyMs: { baselineP95, fixP95, deltaPct,
  --                               flagged },
  --                  dbQueryCount: {}, externalHttpCount: {} }
  --   }]
  -- Powers the card drill-down.
  endpoint_details            jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Separate array for directionally-better endpoints (green signals).
  -- Yellow-light semantics — rendered as wins in UI but NEVER fails the
  -- gate. Same shape as endpoint_details.
  improvements_detected       jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Gate threshold cached at compute time. A later bump invalidates the
  -- cached passed column but leaves underlying counters intact.
  -- Permissive calibration — only drifted_percent drives pass/fail.
  threshold_drifted_percent   double precision NOT NULL DEFAULT 20,
  passed                      boolean,

  started_at                  timestamptz NOT NULL DEFAULT now(),
  completed_at                timestamptz,
  error                       text,

  CONSTRAINT behavioral_drift_runs_unique
    UNIQUE (alert_id, remediation_id, fix_commit_sha)
);

-- Alert detail page reads "latest drift run for this alert" on every
-- paint — same access pattern as fleet_verification_runs_alert_idx.
CREATE INDEX IF NOT EXISTS behavioral_drift_runs_alert_idx
  ON behavioral_drift_runs (alert_id, started_at DESC);

-- Admin/ops view — "which gate runs are still in flight". Partial index
-- stays tiny even at fleet scale.
CREATE INDEX IF NOT EXISTS behavioral_drift_runs_running_idx
  ON behavioral_drift_runs (status)
  WHERE status = 'running';

COMMENT ON TABLE behavioral_drift_runs IS
  'VAR Gate 13. Compares fix replay I/O against the N-day rolling baseline of healthy production recordings built from session_endpoint_metrics. One row per (alert, remediation, fix_commit_sha). Auto-merge reads the passed column. Yellow-light semantics — improvements_detected is populated for wins but does NOT fail the gate. Permissive calibration — only drifted_percent drives pass/fail.';

COMMENT ON COLUMN behavioral_drift_runs.max_drift_score IS
  'Worst per-endpoint MAGNITUDE score across analyzed endpoints, range [0,1]. Structural drift does NOT push this value (permissive calibration) — it appears per-endpoint via has_structural_drift. Null when analyzed_endpoints=0.';

COMMENT ON COLUMN behavioral_drift_runs.endpoint_details IS
  'Per-endpoint drift breakdown for flagged endpoints (either magnitude or structural). Includes magnitudeScore, hasStructuralDrift, per-metric delta. Powers the card drill-down.';

COMMENT ON COLUMN behavioral_drift_runs.improvements_detected IS
  'Per-endpoint improvements (green signals) — fewer db queries, lower 5xx rate, lower p95 latency, dropped slow downstream. Yellow-light semantics, rendered as wins in UI but NEVER fails the auto-merge gate.';
