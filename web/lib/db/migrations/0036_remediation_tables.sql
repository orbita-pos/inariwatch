-- Remediation locks: file-level concurrency control during AI fixes
CREATE TABLE IF NOT EXISTS remediation_locks (
  repo_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  session_id TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (repo_id, file_path)
);

-- Gate telemetry: circuit breaker + dashboard metrics
CREATE TABLE IF NOT EXISTS gate_telemetry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  gate_name TEXT NOT NULL,
  result BOOLEAN NOT NULL,
  error_reason TEXT,
  duration_ms INTEGER,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_gate_telemetry_project ON gate_telemetry(project_id, checked_at DESC);

-- Failed fixes: learning from past failures
CREATE TABLE IF NOT EXISTS failed_fixes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  error_fingerprint TEXT NOT NULL,
  attempted_fix_summary TEXT NOT NULL,
  failure_reason TEXT NOT NULL,
  files_touched JSONB DEFAULT '[]',
  failed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_failed_fixes_fingerprint ON failed_fixes(project_id, error_fingerprint);

-- Confidence calibration: track predicted vs actual outcomes
CREATE TABLE IF NOT EXISTS confidence_calibration (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  predicted_confidence INTEGER NOT NULL,
  actual_outcome BOOLEAN NOT NULL,
  diagnosed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_confidence_calibration_project ON confidence_calibration(project_id, diagnosed_at DESC);

-- Remediation incidents: correlate related remediation sessions
CREATE TABLE IF NOT EXISTS remediation_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_ids JSONB NOT NULL DEFAULT '[]',
  lead_session_id TEXT,
  root_cause TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_remediation_incidents_project ON remediation_incidents(project_id, status);
