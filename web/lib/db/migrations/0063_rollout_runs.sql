-- VAR Q2 Week 12 — Progressive Rollout (1% → 10% → 50% → 100%)
--
-- State machine that gates a merged fix through staged traffic
-- percentages. At each stage the post-merge-monitor runs the existing
-- Sentry/Vercel/uptime regression checks — if any tripwire fires the
-- stage transitions to 'reverted' and the revert PR is auto-filed.
--
-- v1 scope: MANUAL stage advance via API/UI button. Auto-advance on
-- a cron at fixed intervals is a trivial follow-up (just another API
-- call from a cron handler) and lives in the v2 backlog. This keeps
-- the state machine + health checks + rollback wired end-to-end for
-- the first ship without introducing scheduling complexity.
--
-- Stages:
--   pending    — row created, first stage not yet activated
--   canary_1   — 1% traffic exposed to the fix
--   canary_10  — 10% traffic
--   canary_50  — 50% traffic
--   full_100   — 100% traffic, monitoring continues
--   complete   — monitoring window passed clean, rollout finalized
--   reverted   — a health check tripped or operator rolled back
--   failed     — terminal failure state (error column set)
--
-- Health signals at each stage come from the same post-merge-monitor
-- pipeline used for the 10-min post-merge watch today: Sentry error
-- count delta + uptime failures + fingerprint regressions.
--
-- Reverse:
--   DROP TABLE IF EXISTS rollout_runs

CREATE TABLE IF NOT EXISTS rollout_runs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id                 uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  remediation_id           uuid NOT NULL REFERENCES remediation_sessions(id) ON DELETE CASCADE,
  fix_commit_sha           text NOT NULL,

  -- Current stage in the state machine.
  current_stage            text NOT NULL DEFAULT 'pending',

  -- When the CURRENT stage started. Reset on every advance. Used by
  -- the UI to render "in canary_10 for 4m 12s" and by the auto-advance
  -- worker (future) to decide when to bump the next stage.
  stage_started_at         timestamptz NOT NULL DEFAULT now(),

  -- Append-only audit log of every stage transition. Shape:
  --   [{
  --      "stage": "canary_10",
  --      "startedAt": "ISO",
  --      "endedAt": "ISO" | null,
  --      "outcome": "advanced" | "reverted" | "running",
  --      "metrics": { "newErrors": 0, "uptimeFailures": 0,
  --                   "fingerprintRegressions": 0 },
  --      "triggeredBy": "user:<uid>" | "auto" | null
  --   }]
  stage_history            jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Rollback configuration. auto_rollback_enabled=true means the health
  -- check at each stage will trip a rollback if regressions are detected.
  -- When false, the operator sees warnings but must pull the trigger
  -- themselves. Default true — safety on by default.
  auto_rollback_enabled    boolean NOT NULL DEFAULT TRUE,
  rollback_reason          text,
  rollback_pr_url          text,

  -- Tripwire thresholds (per stage). Defaults matched to the existing
  -- post-merge-monitor contract so the Q2 rollout feels continuous with
  -- Q1 behaviour.
  threshold_new_errors          integer NOT NULL DEFAULT 0,
  threshold_uptime_failures     integer NOT NULL DEFAULT 1,
  threshold_fingerprint_regressions integer NOT NULL DEFAULT 0,

  status                   text NOT NULL DEFAULT 'active',
  error                    text,

  started_at               timestamptz NOT NULL DEFAULT now(),
  completed_at             timestamptz,

  CONSTRAINT rollout_runs_unique
    UNIQUE (alert_id, remediation_id, fix_commit_sha)
);

-- Alert detail page reads "latest rollout for this alert" on every
-- paint.
CREATE INDEX IF NOT EXISTS rollout_runs_alert_idx
  ON rollout_runs (alert_id, started_at DESC);

-- Admin/ops view — active rollouts across all alerts. One-at-a-time
-- policy comes later, for now just all in-flight.
CREATE INDEX IF NOT EXISTS rollout_runs_active_idx
  ON rollout_runs (status, current_stage)
  WHERE status = 'active';

COMMENT ON TABLE rollout_runs IS
  'VAR Progressive Rollout (Q2 Week 12). Per-remediation staged rollout 1% → 10% → 50% → 100%. v1 is manual-advance (operator clicks "next stage") with automatic rollback on health regression. Auto-advance on a cron is a v2 addition — the state machine already supports it.';

COMMENT ON COLUMN rollout_runs.current_stage IS
  'pending | canary_1 | canary_10 | canary_50 | full_100 | complete | reverted | failed. See migration header for state semantics.';

COMMENT ON COLUMN rollout_runs.stage_history IS
  'Append-only audit trail. Every stage transition pushes one entry with metrics from that stage. Shape documented in migration header.';

COMMENT ON COLUMN rollout_runs.auto_rollback_enabled IS
  'When TRUE, health checks at each stage auto-trigger a rollback on regression. When FALSE, regressions surface as warnings but require operator action. Safety on by default.';
