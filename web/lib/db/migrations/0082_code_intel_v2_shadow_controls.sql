-- Code Intelligence v2 — Phase 3.1
--
-- Adds the per-workspace shadow-rate override + the v2-timeout flag on
-- the existing shadow-log table. Both columns are additive, default to a
-- "no opinion" value, and keep the Phase 1.5 dispatcher byte-identical for
-- workspaces that don't opt in.
--
-- Per CODE_INTELLIGENCE_V2_HANDOFF.md §3.1:
--   - per-workspace opt-in via `organizations.code_intel_v2_shadow_pct`
--     (NULL = use SHADOW_SAMPLE_RATE env; 0..100 overrides)
--   - timeout guard logs a "v2_slow" event when v2 exceeds 2× v1 wall-clock
--
-- Coexistence invariant: every existing organization has NULL for the new
-- column, which means "fall back to SHADOW_SAMPLE_RATE" — and that env var
-- defaults to 1.0 in the harness, so behavior is identical to Phase 1.5
-- ("shadow runs every call when the engine flag is shadow").
--
-- ── Idempotency ────────────────────────────────────────────────────────────
-- ADD COLUMN IF NOT EXISTS so re-runs are no-ops. Same convention as 0077.
--
-- ── Rollback ───────────────────────────────────────────────────────────────
--   ALTER TABLE organizations DROP COLUMN IF EXISTS code_intel_v2_shadow_pct;
--   ALTER TABLE code_intel_shadow_log DROP COLUMN IF EXISTS v2_timed_out;

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "code_intel_v2_shadow_pct" integer
    CHECK ("code_intel_v2_shadow_pct" IS NULL OR ("code_intel_v2_shadow_pct" BETWEEN 0 AND 100));

COMMENT ON COLUMN "organizations"."code_intel_v2_shadow_pct" IS
  'Code Intel v2 Phase 3.1 — per-workspace override of SHADOW_SAMPLE_RATE. NULL = use the global env var (default 1.0). 0..100 = the percentage of searchCode() calls that get the shadow run. Lets a single workspace ramp shadow up/down without flipping the global flag.';

ALTER TABLE "code_intel_shadow_log"
  ADD COLUMN IF NOT EXISTS "v2_timed_out" boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN "code_intel_shadow_log"."v2_timed_out" IS
  'Code Intel v2 Phase 3.1 — true when v2 exceeded 2× v1 wall-clock. Caller still received v1; the v2 attempt was abandoned. Drives the cutover dashboard "v2 slow" metric (Phase 3.3).';
