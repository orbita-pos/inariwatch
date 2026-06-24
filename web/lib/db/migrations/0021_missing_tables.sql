-- Safety migration: CREATE TABLE IF NOT EXISTS for all tables that were
-- historically created via drizzle-kit push (no migration file existed).
-- All statements are idempotent — safe to run against a live DB.

-- ── Incident Storms ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "incident_storms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamp DEFAULT now() NOT NULL,
  "resolved_at" timestamp
);

-- ── Uptime Monitoring ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "uptime_monitors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "url" text NOT NULL,
  "name" text,
  "interval_sec" integer DEFAULT 60 NOT NULL,
  "expected_status" integer DEFAULT 200 NOT NULL,
  "timeout_ms" integer DEFAULT 10000 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "is_down" boolean DEFAULT false NOT NULL,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  "heal_triggered_at" timestamp,
  "last_checked_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "uptime_checks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "monitor_id" uuid NOT NULL REFERENCES "uptime_monitors"("id") ON DELETE CASCADE,
  "status_code" integer,
  "response_time_ms" integer,
  "is_up" boolean NOT NULL,
  "error" text,
  "checked_at" timestamp DEFAULT now() NOT NULL
);

-- ── On-Call Schedules ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "on_call_schedules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "timezone" text DEFAULT 'UTC' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "on_call_slots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "schedule_id" uuid NOT NULL REFERENCES "on_call_schedules"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "level" integer DEFAULT 1 NOT NULL,
  "day_start" integer NOT NULL,
  "day_end" integer NOT NULL,
  "hour_start" integer DEFAULT 0 NOT NULL,
  "hour_end" integer DEFAULT 23 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "on_call_overrides" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "schedule_id" uuid NOT NULL REFERENCES "on_call_schedules"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "level" integer DEFAULT 1 NOT NULL,
  "starts_at" timestamp NOT NULL,
  "ends_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

-- ── Substrate Recordings ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "substrate_recordings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "recording_id" text NOT NULL,
  "alert_id" uuid REFERENCES "alerts"("id") ON DELETE SET NULL,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE CASCADE,
  "command" text,
  "runtime" text DEFAULT 'node',
  "started_at" timestamptz,
  "ended_at" timestamptz,
  "event_count" integer DEFAULT 0,
  "duration_ms" integer,
  "categories" jsonb,
  "context" text,
  "events" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "substrate_recordings_recording_id_unique" UNIQUE ("recording_id")
);

-- ── Predictions ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "predictions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "pr_number" integer NOT NULL,
  "repo" text NOT NULL,
  "predicted_error" text NOT NULL,
  "predicted_file" text,
  "predicted_line" integer,
  "confidence" integer NOT NULL,
  "risk_level" text NOT NULL,
  "replay_risk_score" integer,
  "outcome" text DEFAULT 'pending' NOT NULL,
  "matched_alert_id" uuid REFERENCES "alerts"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "resolved_at" timestamptz
);

-- ── Slack Bot ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "slack_installations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid REFERENCES "organizations"("id") ON DELETE SET NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "team_id" text NOT NULL,
  "team_name" text NOT NULL,
  "bot_token" text NOT NULL,
  "bot_user_id" text NOT NULL,
  "scopes" text[] DEFAULT '{}',
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now(),
  CONSTRAINT "slack_installations_team_id_unique" UNIQUE ("team_id")
);

CREATE TABLE IF NOT EXISTS "slack_channel_mappings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "installation_id" uuid NOT NULL REFERENCES "slack_installations"("id") ON DELETE CASCADE,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "channel_id" text NOT NULL,
  "channel_name" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "slack_message_threads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "installation_id" uuid NOT NULL REFERENCES "slack_installations"("id") ON DELETE CASCADE,
  "channel_id" text NOT NULL,
  "thread_ts" text NOT NULL,
  "alert_id" uuid REFERENCES "alerts"("id") ON DELETE CASCADE,
  "storm_id" uuid REFERENCES "incident_storms"("id") ON DELETE CASCADE,
  "type" text NOT NULL DEFAULT 'alert',
  "created_at" timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "slack_user_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "installation_id" uuid NOT NULL REFERENCES "slack_installations"("id") ON DELETE CASCADE,
  "slack_user_id" text NOT NULL,
  "created_at" timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "deploy_monitors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "channel_id" text NOT NULL,
  "thread_ts" text NOT NULL,
  "installation_id" uuid NOT NULL REFERENCES "slack_installations"("id") ON DELETE CASCADE,
  "deploy_source" text NOT NULL,
  "deploy_id" text,
  "check_at" timestamp NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "created_at" timestamp DEFAULT now()
);

-- ── Missing columns on existing tables ────────────────────────────────────────

-- alerts.storm_id (FK to incident_storms — incident_storms must exist first)
ALTER TABLE "alerts"
  ADD COLUMN IF NOT EXISTS "storm_id" uuid REFERENCES "incident_storms"("id") ON DELETE SET NULL;

-- alerts.fingerprint (error fingerprint for outcome tracking)
ALTER TABLE "alerts"
  ADD COLUMN IF NOT EXISTS "fingerprint" text;

-- projects.visibility ('all' | 'restricted')
ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "visibility" text NOT NULL DEFAULT 'all';

-- escalation_rules.target_type ('channel' | 'on_call_primary' | 'on_call_secondary')
ALTER TABLE "escalation_rules"
  ADD COLUMN IF NOT EXISTS "target_type" text NOT NULL DEFAULT 'channel';

-- ── Indexes ────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "idx_uptime_checks_monitor" ON "uptime_checks" ("monitor_id", "checked_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_predictions_project" ON "predictions" ("project_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_slack_threads_alert" ON "slack_message_threads" ("alert_id");
CREATE INDEX IF NOT EXISTS "idx_deploy_monitors_status" ON "deploy_monitors" ("status", "check_at");
