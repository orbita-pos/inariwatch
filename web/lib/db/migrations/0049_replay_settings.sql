-- Replay V2 per-project configuration: sampling rates, retention, PII policy.
-- jsonb column instead of discrete rows because the schema will evolve
-- (per-route sampling, custom redact selectors, etc.) and this avoids
-- repeated migrations. Defaults live in TypeScript so changing them doesn't
-- require a backfill.

ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "replay_settings" jsonb NOT NULL DEFAULT '{}'::jsonb;
