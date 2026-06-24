-- Rollback for 0069_telemetry_foundation.sql.
--
-- Run only if Fase 1 needs to be reversed. Drops in the reverse order of the
-- forward migration so foreign keys resolve cleanly. pgvector is left enabled
-- because 0028_code_intelligence.sql still depends on it.

-- 4. pattern_memory
DROP INDEX IF EXISTS idx_pattern_memory_project_last_used;
DROP INDEX IF EXISTS idx_pattern_memory_embedding;
DROP INDEX IF EXISTS idx_pattern_memory_project_fingerprint;
DROP TABLE IF EXISTS pattern_memory;

-- 3. sandbox_audit_log
DROP INDEX IF EXISTS idx_sandbox_audit_log_success_created;
DROP INDEX IF EXISTS idx_sandbox_audit_log_session_created;
DROP TABLE IF EXISTS sandbox_audit_log;

-- 2. remediation_sessions
DROP INDEX IF EXISTS idx_remediation_sessions_tier_created;
ALTER TABLE remediation_sessions
  DROP CONSTRAINT IF EXISTS remediation_sessions_hypothesis_count_non_negative,
  DROP CONSTRAINT IF EXISTS remediation_sessions_pattern_match_score_range,
  DROP COLUMN IF EXISTS sdk_peer_enabled,
  DROP COLUMN IF EXISTS sandbox_mode,
  DROP COLUMN IF EXISTS pattern_match_score,
  DROP COLUMN IF EXISTS hypothesis_count,
  DROP COLUMN IF EXISTS tier_used;

-- 1. ai_usage_logs
DROP INDEX IF EXISTS idx_ai_usage_logs_model_tier_created;
DROP INDEX IF EXISTS idx_ai_usage_logs_phase_created;
ALTER TABLE ai_usage_logs
  DROP CONSTRAINT IF EXISTS ai_usage_logs_reasoning_non_negative,
  DROP CONSTRAINT IF EXISTS ai_usage_logs_tool_exec_positive,
  DROP CONSTRAINT IF EXISTS ai_usage_logs_ttft_positive,
  DROP COLUMN IF EXISTS reasoning_tokens,
  DROP COLUMN IF EXISTS tool_exec_ms,
  DROP COLUMN IF EXISTS tool_name,
  DROP COLUMN IF EXISTS model_tier,
  DROP COLUMN IF EXISTS phase,
  DROP COLUMN IF EXISTS ttft_ms,
  DROP COLUMN IF EXISTS turn_number;
