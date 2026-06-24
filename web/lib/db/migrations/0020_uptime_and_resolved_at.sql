-- Add missing columns to uptime_monitors (is_down, consecutive_failures, heal_triggered_at)
ALTER TABLE "uptime_monitors"
  ADD COLUMN IF NOT EXISTS "is_down" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "consecutive_failures" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "heal_triggered_at" timestamp;

-- Add resolved_at to alerts for MTTR tracking
ALTER TABLE "alerts"
  ADD COLUMN IF NOT EXISTS "resolved_at" timestamp;
