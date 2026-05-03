-- Code Intelligence v2 — Phase 3.2
--
-- Container-agent A/B telemetry. One row per remediation. The worker writes
-- engine + outcome at the end of `runAgentJob`; the cutover dashboard
-- (Phase 3.3) aggregates these rows to decide GO/WAIT/ABORT on flipping
-- v2 to default.
--
-- Per CODE_INTELLIGENCE_V2_HANDOFF.md §3.2:
--   - global CONTAINER_AGENT_AB_PCT (0..100, default 0 = all v1)
--   - per-workspace `organizations.code_intel_v2_agent_ab_pct` overrides
--   - sticky per session (deterministic hash of session id)
--   - hard kill via CONTAINER_AGENT_AB_KILL_V2=1
--
-- Schema rationale:
--   - alert_id NOT NULL — every container-agent run is in service of an
--     alert. The worker resolves it via remediation_sessions. Cascade on
--     alert deletion mirrors all other alert-tied tables.
--   - remediation_session_id NULLABLE — the session may have been deleted
--     by the time the worker telemetry writer attempts the insert (tests
--     and races); we don't want telemetry to be the path that fails the
--     remediation. Cascade SET NULL.
--   - engine VARCHAR + CHECK IN ('v1','v2') instead of pg ENUM so adding
--     a future "v3" doesn't require an enum migration. Same convention as
--     code_symbols.kind (Phase 1.1).
--   - cost_usd NUMERIC(12,6) NULLABLE — worker doesn't aggregate today;
--     Phase 3.4 may backfill from ai_usage_logs by remediation_session_id.
--   - workspace_pct captured at decision time so the cutover script can
--     audit "what pct was the workspace seeing when this row was written?"
--   - failure_reason free-form text, capped at 500 chars on insert.
--
-- Plus an additive ALTER on organizations for the per-workspace pct
-- override. Same shape as the Phase 3.1 `code_intel_v2_shadow_pct` column.
--
-- ── Idempotency ────────────────────────────────────────────────────────────
-- CREATE TABLE / CREATE INDEX / ADD COLUMN all use IF NOT EXISTS so re-runs
-- are no-ops. Same convention as 0079 / 0080 / 0081.
--
-- ── Rollback ───────────────────────────────────────────────────────────────
--   ALTER TABLE organizations DROP COLUMN IF EXISTS code_intel_v2_agent_ab_pct;
--   DROP TABLE IF EXISTS code_intel_remediation_ab;

CREATE TABLE IF NOT EXISTS "code_intel_remediation_ab" (
  "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "alert_id"                 uuid NOT NULL REFERENCES "alerts"("id") ON DELETE CASCADE,
  "remediation_session_id"   uuid REFERENCES "remediation_sessions"("id") ON DELETE SET NULL,
  "engine"                   text NOT NULL,
  "workspace_pct"            integer,
  "turn_count"               integer NOT NULL,
  "success"                  boolean NOT NULL,
  "cost_usd"                 numeric(12, 6),
  "duration_ms"              integer NOT NULL,
  "started_at"               timestamptz NOT NULL,
  "finished_at"              timestamptz NOT NULL,
  "failure_reason"           text,
  "created_at"               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "code_intel_remediation_ab_engine_chk"
    CHECK ("engine" IN ('v1', 'v2')),
  CONSTRAINT "code_intel_remediation_ab_workspace_pct_chk"
    CHECK ("workspace_pct" IS NULL OR ("workspace_pct" BETWEEN 0 AND 100))
);

CREATE INDEX IF NOT EXISTS "idx_code_intel_remediation_ab_alert"
  ON "code_intel_remediation_ab" ("alert_id");

CREATE INDEX IF NOT EXISTS "idx_code_intel_remediation_ab_engine_created"
  ON "code_intel_remediation_ab" ("engine", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_code_intel_remediation_ab_session"
  ON "code_intel_remediation_ab" ("remediation_session_id");

COMMENT ON TABLE "code_intel_remediation_ab" IS
  'Code Intelligence v2 — Phase 3.2 container-agent A/B telemetry. One row per `runAgentJob`. Cutover script (Phase 3.3) aggregates over the engine column to decide GO/WAIT/ABORT on flipping v2 to default.';

COMMENT ON COLUMN "code_intel_remediation_ab"."engine" IS
  'Which tool set the agent saw — v1 (existing read/grep/list) or v2 (existing + find_references / type_at / blast_radius).';

COMMENT ON COLUMN "code_intel_remediation_ab"."workspace_pct" IS
  'organizations.code_intel_v2_agent_ab_pct at decision time; NULL = global env was used. Captured for audit so the cutover script knows the rollout shape.';

COMMENT ON COLUMN "code_intel_remediation_ab"."cost_usd" IS
  'Aggregate AI cost in USD. Worker writes NULL today; Phase 3.4 follow-up may backfill via ai_usage_logs joined on remediation_session_id.';

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "code_intel_v2_agent_ab_pct" integer
    CHECK ("code_intel_v2_agent_ab_pct" IS NULL OR ("code_intel_v2_agent_ab_pct" BETWEEN 0 AND 100));

COMMENT ON COLUMN "organizations"."code_intel_v2_agent_ab_pct" IS
  'Code Intel v2 Phase 3.2 — per-workspace override of CONTAINER_AGENT_AB_PCT. NULL = inherit env (default 0 = all v1). 0..100 = the percentage of remediations that get the v2 tool set. Sticky per session — same alert never sees both engines mid-flight.';
