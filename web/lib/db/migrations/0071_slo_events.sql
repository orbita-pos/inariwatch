-- Fase 12 Part A — SLO events
--
-- Per-tier SLO breach tracking for the remediation pipeline. InariLens
-- (/admin/ai) reads this table directly — SLO breaches are an ops signal,
-- not a customer-facing alert, so they do not flow through the `alerts`
-- table.
--
-- Model: one OPEN event per (tier, metric) at a time. The cron job runs
-- every 5 minutes. If the same breach is still live, UPDATE the existing
-- row (bump last_breach_at + consecutive_breach_count + observed_value).
-- If the tier recovers, stamp resolved_at. Historical rows (resolved_at
-- NOT NULL) form the audit trail.
--
-- "3 consecutive 5-min windows" (arch spec) == consecutive_breach_count
-- >= 3. The widget highlights rows at that threshold. Below that, the
-- breach is noise and stays unhighlighted.
--
-- SLO thresholds live in lib/ai/slo-monitor.ts; this table records
-- observed values + the threshold that was in force at the time so that
-- retrospective changes to thresholds do not mutate history.
--
-- Rollback:
--   DROP TABLE IF EXISTS slo_events;

CREATE TABLE IF NOT EXISTS slo_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which tier breached. '0' | '1' | '2' | '3'. Kept as text to mirror
  -- remediation_sessions.tier_used and tolerate future tier additions.
  tier text NOT NULL,

  -- Which SLO breached. 'p95_latency_ms' | 'success_rate'.
  metric text NOT NULL,

  -- Threshold in force when the breach was recorded. Same unit as
  -- observed_value (ms for p95_latency_ms, fraction [0,1] for
  -- success_rate).
  threshold_value real NOT NULL,
  observed_value real NOT NULL,

  -- How many remediation sessions contributed to the measurement. Low
  -- sample counts weaken the signal; widget can hide rows with < 5.
  sample_count integer NOT NULL,

  -- How many consecutive 5-min cron runs have reported this breach as
  -- open. >= 3 triggers visible highlight / paging (matches arch spec).
  consecutive_breach_count integer NOT NULL DEFAULT 1,

  first_breach_at timestamptz NOT NULL DEFAULT now(),
  last_breach_at timestamptz NOT NULL DEFAULT now(),
  -- Stamped when the metric recovers below threshold on a subsequent
  -- cron run. NULL while the breach is open.
  resolved_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now()
);

-- At most one OPEN event per (tier, metric). The cron UPSERT uses this
-- partial unique index as the conflict target.
CREATE UNIQUE INDEX IF NOT EXISTS slo_events_open_unique
  ON slo_events (tier, metric)
  WHERE resolved_at IS NULL;

-- History scans for the widget and reports.
CREATE INDEX IF NOT EXISTS slo_events_history
  ON slo_events (tier, metric, created_at DESC);

COMMENT ON TABLE slo_events IS
  'Fase 12 Part A — SLO breach tracking for the remediation pipeline. One open row per (tier, metric); closed rows form the history. Read by /admin/ai and the SLO check cron.';

COMMENT ON COLUMN slo_events.consecutive_breach_count IS
  'How many consecutive 5-min cron runs reported this breach as open. >= 3 matches the arch spec paging threshold (e.g. "Tier 1 p95 > 30s for 3 consecutive 5-min windows").';

COMMENT ON COLUMN slo_events.threshold_value IS
  'Threshold that was in force when the row was recorded. Historical thresholds are preserved here so future threshold edits do not mutate past breaches.';
