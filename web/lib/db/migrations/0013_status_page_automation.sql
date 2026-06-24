-- Status page automation: incidents, timeline updates, and subscribers

-- Config column on existing status_pages table
ALTER TABLE "status_pages" ADD COLUMN "config" jsonb DEFAULT '{}';

-- Auto-created incidents linked to alerts
CREATE TABLE "status_page_incidents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "status_page_id" uuid NOT NULL REFERENCES "status_pages"("id") ON DELETE CASCADE,
  "alert_id" uuid REFERENCES "alerts"("id") ON DELETE SET NULL,
  "remediation_session_id" uuid REFERENCES "remediation_sessions"("id") ON DELETE SET NULL,
  "title" text NOT NULL,
  "status" text NOT NULL DEFAULT 'investigating',
  "severity" text NOT NULL DEFAULT 'major',
  "started_at" timestamptz DEFAULT NOW(),
  "resolved_at" timestamptz,
  "postmortem" text,
  "created_at" timestamptz DEFAULT NOW(),
  "updated_at" timestamptz DEFAULT NOW()
);

CREATE INDEX "idx_sp_incidents_page" ON "status_page_incidents" ("status_page_id", "status");
CREATE INDEX "idx_sp_incidents_alert" ON "status_page_incidents" ("alert_id");

-- Timeline updates per incident
CREATE TABLE "status_page_updates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "incident_id" uuid NOT NULL REFERENCES "status_page_incidents"("id") ON DELETE CASCADE,
  "status" text NOT NULL,
  "message" text NOT NULL,
  "is_auto_generated" boolean DEFAULT true,
  "created_at" timestamptz DEFAULT NOW()
);

CREATE INDEX "idx_sp_updates_incident" ON "status_page_updates" ("incident_id", "created_at");

-- Email subscribers for status page notifications
CREATE TABLE "status_page_subscribers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "status_page_id" uuid NOT NULL REFERENCES "status_pages"("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "verified" boolean DEFAULT false,
  "unsubscribe_token" text NOT NULL DEFAULT gen_random_uuid(),
  "created_at" timestamptz DEFAULT NOW(),
  UNIQUE("status_page_id", "email")
);
