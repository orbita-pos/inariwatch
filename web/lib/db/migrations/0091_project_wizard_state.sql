-- Inari Live V1 — Session 3: project wizard state machine.
--
-- Adds three columns to `projects` so the Add-Project wizard can drive
-- a project from "user clicked Add" all the way to "first event verified"
-- and the dashboard can render the right CTA at each stage.
--
-- Decisions (per INARI_LIVE_V1_PLAN.md → "Add Project flow"):
--   * State machine is `created → needs_setup → setting_up → prepared
--     → verified → live` (+ `archived`).
--   * Existing rows predate S3 — they're either fully wired up (the
--     pre-existing dogfood projects) or imported from GitHub but not
--     yet connected to capture. Defaulting to `live` is the correct
--     backwards-compat choice: the dashboard treats `live` as "show
--     the regular alerts UI", which is what every pre-S3 project
--     should fall through to.
--   * `framework` and `host` are nullable because Tier 2/3 hosts (S4)
--     and self-hosted setups still need the wizard but won't auto-sync.
--     V1 only writes `host = 'vercel'` — V2/V1.5 expands to netlify,
--     railway, fly, render, cloudflare, heroku.
--
-- A CHECK constraint enforces the enum rather than a Postgres ENUM type
-- so that future state additions (e.g. `migrating`, `failed`) ship as
-- a one-line constraint swap instead of a `ALTER TYPE ... ADD VALUE`
-- transaction-bound dance.

ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "state" text NOT NULL DEFAULT 'live';

ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "framework" text;

ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "host" text;

-- The CHECK is added AFTER the column so existing rows (defaulted to
-- 'live') don't fail validation mid-migration. NOT VALID would have
-- worked too, but for a 7-value enum on a small table the up-front
-- validation cost is negligible and avoids a follow-up VALIDATE step.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'projects_state_chk'
  ) THEN
    ALTER TABLE "projects"
      ADD CONSTRAINT "projects_state_chk"
      CHECK ("state" IN (
        'created',
        'needs_setup',
        'setting_up',
        'prepared',
        'verified',
        'live',
        'archived'
      ));
  END IF;
END $$;

-- Dashboard "open wizards" filter: project list view filters by state
-- in {needs_setup, setting_up, prepared} to render the in-flight panel.
-- Partial index keeps the planner cheap — most rows live forever in
-- state='live' and don't need to share an index seek surface.
CREATE INDEX IF NOT EXISTS "projects_state_inflight_idx"
  ON "projects"("state", "created_at")
  WHERE "state" IN ('needs_setup', 'setting_up', 'prepared', 'verified');
