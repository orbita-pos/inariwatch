-- Add error fingerprint column to remediation_sessions for fix replay matching
ALTER TABLE "remediation_sessions" ADD COLUMN "fingerprint" text;
CREATE INDEX "idx_remediation_fingerprint" ON "remediation_sessions" ("project_id", "fingerprint");
