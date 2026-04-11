-- AI usage logs: per-call telemetry for BYOK cost tracking
--
-- Tracks every AI provider call made on behalf of a user so they can see
-- exactly what their BYOK key is being spent on. Scoped per user — each
-- user only sees their own usage in the dashboard.
CREATE TABLE IF NOT EXISTS ai_usage_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  alert_id UUID REFERENCES alerts(id) ON DELETE SET NULL,
  remediation_session_id UUID REFERENCES remediation_sessions(id) ON DELETE SET NULL,

  -- What feature triggered the call
  feature TEXT NOT NULL,
  -- 'auto-analyze' | 'remediation' | 'chat' | 'security-scan'
  -- | 'risk-assessment' | 'postmortem' | 'correlate' | 'other'

  -- Which provider and model were used
  provider TEXT NOT NULL,
  -- 'openai' | 'claude' | 'gemini' | 'grok' | 'deepseek' | 'groq'
  model TEXT NOT NULL,
  -- e.g. 'gpt-4o-mini', 'claude-sonnet-4-6', 'gpt-5.4'

  -- Token counts from provider response
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,

  -- Computed cost in USD (based on pricing at time of call)
  cost_usd NUMERIC(12, 8) NOT NULL DEFAULT 0,

  -- Whether this call used the platform key (free tier) vs user's BYOK
  is_platform_key BOOLEAN NOT NULL DEFAULT false,

  -- Error tracking — null if call succeeded
  error TEXT,

  -- Latency in milliseconds (optional — useful for performance tuning)
  duration_ms INTEGER,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Primary query: user's usage over a time range
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_user_created
  ON ai_usage_logs(user_id, created_at DESC);

-- Filter by project (workspace-level rollups)
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_project_created
  ON ai_usage_logs(project_id, created_at DESC)
  WHERE project_id IS NOT NULL;

-- Link back to alerts/sessions for drill-down
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_alert
  ON ai_usage_logs(alert_id)
  WHERE alert_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_session
  ON ai_usage_logs(remediation_session_id)
  WHERE remediation_session_id IS NOT NULL;

-- Aggregation by feature/model
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_feature
  ON ai_usage_logs(user_id, feature, created_at DESC);

-- User-settable monthly budget — notification trigger when spend approaches limit.
-- Stored on users table as a nullable column.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS ai_budget_monthly_usd NUMERIC(10, 2);
