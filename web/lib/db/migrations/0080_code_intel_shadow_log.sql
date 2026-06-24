-- Code Intelligence v2 — Phase 1.5
--
-- Per CODE_INTELLIGENCE_V2_HANDOFF.md §1.5 + 1.7. When the engine flag is
-- "shadow" the service-layer dispatcher runs BOTH v1 and v2 against every
-- searchCode() call, returns v1 to the caller, and writes one row to this
-- table per call. The /admin/ops widget (Phase 1.7) reads from here.
--
-- Each row is one A/B comparison sample — small enough that we don't worry
-- about retention for the shadow window (1-2 weeks per the cutover plan).
-- Phase 3 may add a daily summary aggregator before cutover.
--
-- Rollback:
--   DROP TABLE IF EXISTS code_intel_shadow_log;

CREATE TABLE IF NOT EXISTS "code_intel_shadow_log" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repo_id"          uuid REFERENCES "code_repositories"("id") ON DELETE CASCADE,
  "project_id"       uuid,
  "query"            text NOT NULL,
  "v1_result_count"  integer NOT NULL,
  "v2_result_count"  integer NOT NULL,
  -- Top FQNs returned by each engine, for divergence analysis. Trimmed to
  -- ~10 entries per engine to keep rows compact.
  "v1_top_fqns"      jsonb NOT NULL DEFAULT '[]'::jsonb,
  "v2_top_fqns"      jsonb NOT NULL DEFAULT '[]'::jsonb,
  "v1_duration_ms"   integer NOT NULL,
  "v2_duration_ms"   integer NOT NULL,
  "v1_error"         text,
  "v2_error"         text,
  "created_at"       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_code_intel_shadow_repo_created"
  ON "code_intel_shadow_log" ("repo_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_code_intel_shadow_project_created"
  ON "code_intel_shadow_log" ("project_id", "created_at" DESC);

COMMENT ON TABLE "code_intel_shadow_log" IS
  'Code Intelligence v2 — Phase 1.5/1.7 A/B sample log. Populated by web/lib/services/code-intelligence.service.ts when CODE_INTEL_V2=shadow. Drives the /admin/ops "v1 vs v2" widget.';
