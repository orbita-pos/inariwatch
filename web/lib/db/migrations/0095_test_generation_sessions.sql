-- Test generation sessions — mirror of remediation_sessions for the
-- `/test <path>` flow. Each row tracks one user request to generate
-- tests for a file or function.
--
-- Lifecycle:
--   pending      → user clicked or called /test
--   exploring    → AI is reading file + callers + style examples
--   planning     → AI is generating test plan (Pass 1, cheap model)
--   writing      → AI is generating test code (Pass 2, code flagship)
--   verifying    → tests are running in container (pass/fail)
--   reviewing    → quality gates running (no expect(true), assertions, etc.)
--   ready        → tests verified clean, awaiting user action
--   delivered    → PR opened OR written to local clone
--   failed       → could not generate quality tests within budget
--   cancelled    → user dismissed before completion

CREATE TABLE test_generation_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Input
  -- source: 'file' | 'function' | 'alert' | 'recording' | 'diff'
  source_kind     TEXT NOT NULL,
  -- The target — for 'file': path. For 'function': "path.ts:symbolName".
  -- For 'alert': alertId. For 'recording': recordingId. For 'diff': base ref.
  source_target   TEXT NOT NULL,
  -- Optional: if user wants a specific framework (overrides detection)
  framework_hint  TEXT,

  -- Pipeline state
  -- pending | exploring | planning | writing | verifying | reviewing |
  -- ready | delivered | failed | cancelled
  status          TEXT NOT NULL DEFAULT 'pending',
  steps           JSONB NOT NULL DEFAULT '[]'::jsonb,
  error           TEXT,

  -- Detected at runtime by the orchestrator
  -- 'vitest' | 'jest' | 'mocha' | 'playwright' | 'cypress' | 'bun-test' | 'deno-test' | 'unknown'
  framework_detected TEXT,
  -- Test files the AI generated (relative paths in repo).
  test_files      JSONB,  -- [{ path: string, content: string }]
  -- Test plan from Pass 1: array of { name, scenario, inputs, expected, mocks }
  test_plan       JSONB,
  -- Self-review verdict: { score, concerns[], rejected_cases[], approved: bool }
  review_result   JSONB,
  -- Quality gate findings: { passed: string[], failed: string[] }
  quality_gates   JSONB,

  -- Verification — what running the tests in a container returned
  -- { command, exit_code, passed: number, failed: number, stdout, stderr }
  verification    JSONB,

  -- Output
  -- 'pr' | 'local' | 'inline'  (how the user wants the result)
  delivery_mode   TEXT,
  pr_url          TEXT,
  pr_number       INTEGER,
  local_path      TEXT,         -- absolute path on user's machine if mode=local

  -- Telemetry
  -- explore_model, plan_model, write_model, review_model — which Qwen/etc was used at each stage
  models_used     JSONB,
  -- { explore: n, plan: n, write: n, review: n } token counts per phase
  tokens_in       JSONB,
  tokens_out      JSONB,
  cost_cents      INTEGER NOT NULL DEFAULT 0,
  duration_ms     INTEGER,

  -- Audit / provenance
  -- Witness receipt ID — links to a recorded session for verifiable provenance
  witness_receipt_id TEXT,
  -- The single alert this is a regression test for (if source=alert).
  alert_id        UUID REFERENCES alerts(id) ON DELETE SET NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX test_generation_sessions_project_idx
  ON test_generation_sessions (project_id, created_at DESC);

CREATE INDEX test_generation_sessions_user_idx
  ON test_generation_sessions (user_id, created_at DESC);

CREATE INDEX test_generation_sessions_status_idx
  ON test_generation_sessions (status)
  WHERE status NOT IN ('delivered', 'failed', 'cancelled');

CREATE INDEX test_generation_sessions_alert_idx
  ON test_generation_sessions (alert_id)
  WHERE alert_id IS NOT NULL;

-- Standard updated_at trigger pattern used by other tables in this schema
CREATE OR REPLACE FUNCTION update_test_generation_sessions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER test_generation_sessions_updated_at_trigger
  BEFORE UPDATE ON test_generation_sessions
  FOR EACH ROW
  EXECUTE FUNCTION update_test_generation_sessions_updated_at();
