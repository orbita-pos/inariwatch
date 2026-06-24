-- Inari Live V1 — Session 2: Project tokens for the capture pipeline.
--
-- Mintable from web (and later from Inari Live desktop). Stored only as
-- SHA-256 hash; plaintext is shown once on creation and never retrievable.
-- Coexists with the legacy per-project_integrations webhookSecret model:
-- a project may have BOTH a project_integrations row (DSN/HMAC) AND any
-- number of project_tokens rows (Bearer). The capture webhook resolves
-- the auth mode from the request — see web/lib/webhooks/shared.ts.
--
-- Plan: INARI_LIVE_V1_PLAN.md → "Project token model" + Session 2 schema.
-- Format note vs plan: the plan listed `workspace_id` as NOT NULL referencing
-- `workspaces(id)`. In this codebase "workspace" is the user-facing alias for
-- `organizations` (see aiRouterReceipts and the workspace.ts helper). Personal
-- projects have organization_id IS NULL, so workspace_id here is nullable to
-- match the existing data shape.

CREATE TABLE IF NOT EXISTS "project_tokens" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id"   uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "workspace_id" uuid REFERENCES "organizations"("id") ON DELETE CASCADE,
  "token_hash"   text NOT NULL UNIQUE,
  "token_prefix" text NOT NULL,
  "scope"        text[] NOT NULL DEFAULT ARRAY['events:write']::text[],
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz,
  "revoked_at"   timestamptz,
  "rotated_to"   uuid REFERENCES "project_tokens"("id") ON DELETE SET NULL,
  "created_via"  text NOT NULL,
  "created_by"   uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "device_label" text
);

-- Hot-path index for capture webhook lookups: filtered to live tokens so
-- revoked rows don't bloat the seek surface. Postgres uses this index for
-- the SHA-256 hash equality check on every alert ingest.
CREATE UNIQUE INDEX IF NOT EXISTS "project_tokens_hash_idx"
  ON "project_tokens"("token_hash") WHERE "revoked_at" IS NULL;

-- Per-project listing (Settings → Tokens panel + cron grace sweep filter).
CREATE INDEX IF NOT EXISTS "project_tokens_project_idx"
  ON "project_tokens"("project_id");

-- Cron sweep: find rotated tokens whose 24h grace has elapsed.
CREATE INDEX IF NOT EXISTS "project_tokens_grace_idx"
  ON "project_tokens"("rotated_to", "created_at")
  WHERE "rotated_to" IS NOT NULL AND "revoked_at" IS NULL;
