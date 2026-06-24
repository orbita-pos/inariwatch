ALTER TABLE remediation_sessions ADD COLUMN IF NOT EXISTS context JSONB;--> statement-breakpoint
ALTER TABLE error_patterns ADD COLUMN IF NOT EXISTS context_summary TEXT;