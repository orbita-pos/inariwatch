-- Replay V2: dedicated metadata table with R2-backed block storage.
-- Backward-compatible: substrate_recordings keeps working untouched, only adds
-- an optional FK pointing to a new replay_sessions row when V2 is enabled.

CREATE TABLE IF NOT EXISTS "replay_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id" text NOT NULL UNIQUE,
  "organization_id" uuid REFERENCES "organizations"("id") ON DELETE CASCADE,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE CASCADE,
  "alert_id" uuid REFERENCES "alerts"("id") ON DELETE SET NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,

  "started_at" timestamptz NOT NULL,
  "ended_at" timestamptz,
  "duration_ms" integer,

  "r2_prefix" text NOT NULL,
  "block_count" integer NOT NULL DEFAULT 0,
  "total_bytes" bigint NOT NULL DEFAULT 0,

  "click_selectors" text[] NOT NULL DEFAULT '{}',
  "urls_visited" text[] NOT NULL DEFAULT '{}',
  "error_fingerprints" text[] NOT NULL DEFAULT '{}',
  "frustration_score" integer NOT NULL DEFAULT 0,

  "browser" text,
  "os" text,
  "country" text,
  "viewport" jsonb,

  "ai_summary" text,
  "ai_chapters" jsonb,

  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_replay_sessions_org_started"
  ON "replay_sessions" ("organization_id", "started_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_replay_sessions_project_started"
  ON "replay_sessions" ("project_id", "started_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_replay_sessions_alert"
  ON "replay_sessions" ("alert_id") WHERE "alert_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_replay_sessions_clicks"
  ON "replay_sessions" USING GIN ("click_selectors");

CREATE INDEX IF NOT EXISTS "idx_replay_sessions_errors"
  ON "replay_sessions" USING GIN ("error_fingerprints");

-- Backward-compatible link from existing substrate_recordings to a replay_sessions row.
ALTER TABLE "substrate_recordings"
  ADD COLUMN IF NOT EXISTS "replay_session_id" uuid REFERENCES "replay_sessions"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "idx_substrate_recordings_replay_session"
  ON "substrate_recordings" ("replay_session_id") WHERE "replay_session_id" IS NOT NULL;
