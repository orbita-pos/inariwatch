-- VAR Q2 Week 9 — Gate 14 "Cost Impact"
--
-- Measures the infra cost a remediation incurred (AI calls) and
-- compares it to a workspace-configured threshold. Source data lives
-- in ai_usage_logs (cost_usd, tokens, feature per call) — this table
-- is a frozen snapshot per (alert, remediation, fix sha) for audit
-- trail + fast dashboard reads.
--
-- v1 scope: cost of the remediation itself (diagnose + self-review +
-- fix generation + security-scan AI review). Does NOT include infra
-- cost delta of the DEPLOYED fix (new dependencies, infra spend change)
-- — that requires external telemetry beyond the scope of this gate.
--
-- Gate passes when remediation_cost_usd <= threshold_usd. Default
-- threshold 1.00 USD, configurable per-run. Calibrated against memory
-- note: typical remediation costs ~$0.25 with prompt caching enabled.
--
-- Skip outcomes (passed=null, auto-merge treats as skip):
--   no-logs      — zero ai_usage_logs rows for this remediation
--                  (AI calls went direct, not through logged path)
--
-- Reverse:
--   DROP TABLE IF EXISTS cost_impact_runs

CREATE TABLE IF NOT EXISTS cost_impact_runs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id               uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  remediation_id         uuid NOT NULL REFERENCES remediation_sessions(id) ON DELETE CASCADE,
  fix_commit_sha         text NOT NULL,

  -- Snapshot of aggregated cost at gate eval time. Frozen on write so
  -- threshold changes after the fact do not retroactively change a
  -- decision (the underlying ai_usage_logs rows remain the source of
  -- truth if a re-score is ever needed).
  remediation_cost_usd   numeric(12, 8) NOT NULL DEFAULT 0,
  token_count_input      integer NOT NULL DEFAULT 0,
  token_count_output     integer NOT NULL DEFAULT 0,
  token_count_cached     integer NOT NULL DEFAULT 0,
  call_count             integer NOT NULL DEFAULT 0,

  -- Per-feature breakdown for the UI drill-down. Shape:
  --   { "remediation": { "costUsd": 0.21, "inputTokens": 9000,
  --                      "outputTokens": 4000, "callCount": 2 },
  --     "security-scan": {...}, "self-review": {...} }
  cost_breakdown         jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Budget cached on the row. A later threshold bump invalidates the
  -- cached passed column but leaves the underlying cost intact.
  threshold_usd          numeric(12, 8) NOT NULL DEFAULT 1.00,

  -- Gate outcome. passed=null means SKIP (no logs found for this
  -- remediation, or logs exist but aggregate to zero cost).
  passed                 boolean,

  status                 text NOT NULL DEFAULT 'running',
  error                  text,

  started_at             timestamptz NOT NULL DEFAULT now(),
  completed_at           timestamptz,

  CONSTRAINT cost_impact_runs_unique
    UNIQUE (alert_id, remediation_id, fix_commit_sha)
);

-- Alert detail page reads "latest cost impact for alert".
CREATE INDEX IF NOT EXISTS cost_impact_runs_alert_idx
  ON cost_impact_runs (alert_id, started_at DESC);

CREATE INDEX IF NOT EXISTS cost_impact_runs_running_idx
  ON cost_impact_runs (status)
  WHERE status = 'running';

COMMENT ON TABLE cost_impact_runs IS
  'VAR Gate 14. Frozen snapshot of AI cost for a remediation (sum over ai_usage_logs where remediation_session_id matches). One row per (alert, remediation, fix_commit_sha). Passes when remediation_cost_usd <= threshold_usd. passed=null means skip (no logs found) — auto-merge treats as skip, not fail.';

COMMENT ON COLUMN cost_impact_runs.cost_breakdown IS
  'Per-feature cost breakdown. Keys are ai_usage_logs.feature values ("remediation", "security-scan", "self-review", etc.). Each value is { costUsd, inputTokens, outputTokens, callCount }. Powers the UI drill-down.';

COMMENT ON COLUMN cost_impact_runs.remediation_cost_usd IS
  'Sum of ai_usage_logs.cost_usd for rows with this remediation_session_id at eval time. Frozen — the underlying logs stay as source of truth but this snapshot is what the gate decision was made on.';
