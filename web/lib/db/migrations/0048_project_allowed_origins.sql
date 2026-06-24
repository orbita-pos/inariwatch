-- Phase 5 security hardening: per-project Origin allowlist.
-- Empty array (the default for existing rows) preserves current behavior
-- so no project breaks — Origin enforcement is opt-in per project.

ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "allowed_origins" text[] NOT NULL DEFAULT '{}';
