-- Add foreign key on users.active_org_id
ALTER TABLE "users"
  ADD CONSTRAINT "users_active_org_id_fk"
  FOREIGN KEY ("active_org_id") REFERENCES "organizations"("id") ON DELETE SET NULL;

-- Performance indexes for high-traffic tables
CREATE INDEX IF NOT EXISTS "idx_alerts_project_id" ON "alerts" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_alerts_created_at" ON "alerts" ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_alerts_resolved" ON "alerts" ("is_resolved");
CREATE INDEX IF NOT EXISTS "idx_notif_queue_status" ON "notification_queue" ("status");
CREATE INDEX IF NOT EXISTS "idx_project_integrations_active" ON "project_integrations" ("project_id", "is_active");
CREATE INDEX IF NOT EXISTS "idx_org_members_org" ON "organization_members" ("organization_id");
CREATE INDEX IF NOT EXISTS "idx_email_suppressions_email" ON "email_suppressions" ("email");
