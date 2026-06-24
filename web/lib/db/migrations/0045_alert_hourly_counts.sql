-- Alert hourly rollup table for anomaly detection.
-- Replaces the expensive 30-day full scan that ran every 2 minutes.
-- Worker aggregates hourly, anomaly detection reads from this table.

CREATE TABLE IF NOT EXISTS "alert_hourly_counts" (
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "hour" timestamp NOT NULL,
  "alert_count" integer NOT NULL DEFAULT 0,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  PRIMARY KEY ("project_id", "hour")
);

CREATE INDEX IF NOT EXISTS "idx_alert_hourly_counts_hour"
  ON "alert_hourly_counts" ("hour" DESC);
