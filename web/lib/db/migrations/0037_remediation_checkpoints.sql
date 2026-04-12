-- Add crash-recovery checkpoint columns to remediation_sessions
ALTER TABLE "remediation_sessions" ADD COLUMN IF NOT EXISTS "checkpoint_phase" text;
ALTER TABLE "remediation_sessions" ADD COLUMN IF NOT EXISTS "checkpoint_data" jsonb;
ALTER TABLE "remediation_sessions" ADD COLUMN IF NOT EXISTS "staging_deploy_id" text;
