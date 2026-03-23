-- Auto-merge configuration on projects
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "auto_merge_config" jsonb;

-- Extended remediation session tracking
ALTER TABLE "remediation_sessions" ADD COLUMN IF NOT EXISTS "confidence_score" integer;
ALTER TABLE "remediation_sessions" ADD COLUMN IF NOT EXISTS "self_review_result" jsonb;
ALTER TABLE "remediation_sessions" ADD COLUMN IF NOT EXISTS "merge_strategy" text;
ALTER TABLE "remediation_sessions" ADD COLUMN IF NOT EXISTS "merged_commit_sha" text;
ALTER TABLE "remediation_sessions" ADD COLUMN IF NOT EXISTS "monitoring_until" timestamp with time zone;
ALTER TABLE "remediation_sessions" ADD COLUMN IF NOT EXISTS "monitoring_status" text;
ALTER TABLE "remediation_sessions" ADD COLUMN IF NOT EXISTS "revert_pr_url" text;
