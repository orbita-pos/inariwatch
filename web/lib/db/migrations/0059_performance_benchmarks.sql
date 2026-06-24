-- VAR Q2 Week 4 — Gate 17 "Performance Regression"
--
-- Measures whether a remediation introduces a critical-path slowdown.
-- Data source: substrate event timestamps already stored in
-- whatif_replays.result (recorded_events = original prod timing,
-- replayed_events = replay with fix code). We pair http_request/http_response
-- events by correlation id, compute latency per pair, group by URL, then
-- compare baseline p50 vs fix p50 per URL.
--
-- Why no new substrate runs: Gate 12 already populated the timing data.
-- This gate is pure analysis on top — cheap enough to run synchronously
-- or as a fast (<2s) BullMQ job.
--
-- Gate outcome: passes when regression_percent <= threshold_percent
-- (default 10%). Auto-merge evaluator consumes the `passed` column.
--
-- Reverse:
--   DROP TABLE IF EXISTS performance_benchmarks;

CREATE TABLE IF NOT EXISTS performance_benchmarks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id            uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  remediation_id      uuid NOT NULL REFERENCES remediation_sessions(id) ON DELETE CASCADE,
  fix_commit_sha      text NOT NULL,

  -- Aggregate metrics across ALL http pairs found. Null when the recording
  -- had no paired http request/response events (e.g. pure Node service
  -- that only hits DB). In that case the card shows "no HTTP paths to
  -- measure" and the auto-merge gate is skipped (not failed).
  baseline_p50_ms     double precision,
  baseline_p99_ms     double precision,
  fix_p50_ms          double precision,
  fix_p99_ms          double precision,
  regression_percent  double precision,

  -- Per-URL breakdown. Shape:
  --   [{ url, method, baselineP50Ms, fixP50Ms, regressionPct,
  --      sampleSize, slowerThanThreshold }]
  -- sampleSize is the number of request/response pairs matched for that
  -- URL in BOTH recorded and replayed streams.
  affected_paths      jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Gate outcome at compute time. A later threshold change invalidates
  -- the cached `passed` but NOT the underlying metrics. Consumers that
  -- want to reapply a new threshold read regression_percent directly.
  threshold_percent   double precision NOT NULL DEFAULT 10,
  passed              boolean,

  status              text NOT NULL DEFAULT 'running',
  error               text,

  started_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,

  -- One benchmark per (alert, remediation, sha). Rerunning with the same
  -- fix code reuses the row.
  CONSTRAINT performance_benchmarks_unique
    UNIQUE (alert_id, remediation_id, fix_commit_sha)
);

CREATE INDEX IF NOT EXISTS performance_benchmarks_alert_idx
  ON performance_benchmarks (alert_id, started_at DESC);

COMMENT ON TABLE performance_benchmarks IS
  'VAR Gate 17. Measures p50/p99 latency regression from whatif_replays.substrate event timings. One row per (alert, remediation, sha). Auto-merge reads passed column.';

COMMENT ON COLUMN performance_benchmarks.affected_paths IS
  'Array of {url, method, baselineP50Ms, fixP50Ms, regressionPct, sampleSize, slowerThanThreshold}. sampleSize = pairs matched in BOTH recorded and replayed streams.';

COMMENT ON COLUMN performance_benchmarks.regression_percent IS
  'Overall p50 regression as percent. Positive = fix is slower. Negative = fix is faster. Null when no http pairs found.';
