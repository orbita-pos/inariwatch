ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "active_org_id" uuid REFERENCES "organizations"("id") ON DELETE SET NULL;
