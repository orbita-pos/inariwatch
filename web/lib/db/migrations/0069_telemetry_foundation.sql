-- Fase 1 — Telemetry Foundation
--
-- Extends the telemetry surface so subsequent fases (tier router, pattern
-- memory, sandbox execution, SDK peer mode) have typed columns to write to.
-- Nothing in this migration changes runtime behavior: every added column is
-- nullable or has a backward-compatible default. Writers are introduced in
-- later fases.
--
-- Rollback: see 0069_telemetry_foundation.rollback.sql — companion file that
-- reverses every statement here in the opposite order.

-- pgvector is already enabled by 0028_code_intelligence.sql. Declaring it
-- again is a no-op (IF NOT EXISTS) but keeps this migration self-contained
-- when replayed against a fresh database.
CREATE EXTENSION IF NOT EXISTS vector;

-- ── 1. ai_usage_logs — per-turn + per-tool telemetry ────────────────────────
--
-- turn_number, ttft_ms, phase, model_tier, tool_name, tool_exec_ms, and
-- reasoning_tokens are all optional. Existing rows stay valid (NULL = "not
-- measured at time of insert"). The widget in /admin/remediation-lab filters
-- to rows where the needed fields are non-null.

ALTER TABLE ai_usage_logs
  ADD COLUMN IF NOT EXISTS turn_number INTEGER,
  ADD COLUMN IF NOT EXISTS ttft_ms INTEGER,
  ADD COLUMN IF NOT EXISTS phase TEXT,
  -- 'classify' | 'explore' | 'fix' | 'review' | 'graders' | 'other'
  ADD COLUMN IF NOT EXISTS model_tier TEXT,
  -- 'nano' | 'mini' | 'standard' | 'reasoning' — provider-agnostic bucket
  ADD COLUMN IF NOT EXISTS tool_name TEXT,
  ADD COLUMN IF NOT EXISTS tool_exec_ms INTEGER,
  ADD COLUMN IF NOT EXISTS reasoning_tokens INTEGER;

-- Range check on ttft: strictly positive when present. Guards against
-- accidental negative deltas from clock drift in future writers.
DO $$ BEGIN
  ALTER TABLE ai_usage_logs
    ADD CONSTRAINT ai_usage_logs_ttft_positive
    CHECK (ttft_ms IS NULL OR ttft_ms >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE ai_usage_logs
    ADD CONSTRAINT ai_usage_logs_tool_exec_positive
    CHECK (tool_exec_ms IS NULL OR tool_exec_ms >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE ai_usage_logs
    ADD CONSTRAINT ai_usage_logs_reasoning_non_negative
    CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Lab dashboard queries filter by (feature, phase, created_at) — skip rows
-- where phase is null since the widget groups by phase.
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_phase_created
  ON ai_usage_logs (feature, phase, created_at DESC)
  WHERE phase IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_model_tier_created
  ON ai_usage_logs (model_tier, created_at DESC)
  WHERE model_tier IS NOT NULL;

-- ── 2. remediation_sessions — tier + hypothesis + SDK peer metadata ────────
--
-- tier_used stays NULL on sessions created before Fase 6. sdk_peer_enabled
-- defaults to false so every existing row gets a deterministic value and the
-- widget's boolean filter works out of the box.

ALTER TABLE remediation_sessions
  ADD COLUMN IF NOT EXISTS tier_used TEXT,
  -- '0' | '1' | '2' | '3' | 'legacy' — see REMEDIATION_SYSTEM_ARCHITECTURE.md §2 Pillar 1
  ADD COLUMN IF NOT EXISTS hypothesis_count INTEGER,
  ADD COLUMN IF NOT EXISTS pattern_match_score REAL,
  ADD COLUMN IF NOT EXISTS sandbox_mode TEXT,
  -- 'none' | 'codeact-deno' — see ADR-001
  ADD COLUMN IF NOT EXISTS sdk_peer_enabled BOOLEAN NOT NULL DEFAULT false;

-- Score is a cosine similarity in [0, 1]; block malformed writes at the DB.
DO $$ BEGIN
  ALTER TABLE remediation_sessions
    ADD CONSTRAINT remediation_sessions_pattern_match_score_range
    CHECK (pattern_match_score IS NULL OR (pattern_match_score >= 0 AND pattern_match_score <= 1));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE remediation_sessions
    ADD CONSTRAINT remediation_sessions_hypothesis_count_non_negative
    CHECK (hypothesis_count IS NULL OR hypothesis_count >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_remediation_sessions_tier_created
  ON remediation_sessions (tier_used, created_at DESC)
  WHERE tier_used IS NOT NULL;

-- ── 3. sandbox_audit_log — one row per CodeAct invocation (Fase 5) ──────────
--
-- Populated by the Deno+Pyodide runner (worker/src/sandbox/*, introduced in
-- Fase 5). code_hash is a SHA-256 of the model-emitted code string so two
-- identical invocations share a hash without revealing the code body here.
-- The full code is kept in ai_usage_logs.prompt subject to the PII scrubber.

CREATE TABLE IF NOT EXISTS sandbox_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES remediation_sessions(id) ON DELETE SET NULL,
  ai_usage_log_id UUID REFERENCES ai_usage_logs(id) ON DELETE SET NULL,
  code_hash TEXT NOT NULL,
  -- SHA-256 hex of the submitted Python/JS source
  purpose TEXT NOT NULL,
  -- free-form tag the caller sets: 'hypothesis-H1' | 'apply-fix' | ...
  result_size_bytes INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  success BOOLEAN NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE sandbox_audit_log
    ADD CONSTRAINT sandbox_audit_log_duration_non_negative
    CHECK (duration_ms >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE sandbox_audit_log
    ADD CONSTRAINT sandbox_audit_log_result_size_non_negative
    CHECK (result_size_bytes >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE sandbox_audit_log
    ADD CONSTRAINT sandbox_audit_log_code_hash_format
    CHECK (code_hash ~ '^[0-9a-f]{64}$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_sandbox_audit_log_session_created
  ON sandbox_audit_log (session_id, created_at DESC)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sandbox_audit_log_success_created
  ON sandbox_audit_log (success, created_at DESC);

-- ── 4. pattern_memory — per-project fingerprint → fix index (Fase 6) ───────
--
-- 1024-dim embedding matches the existing code_chunks / fix_embedding schema
-- (text-embedding-3-small / text-embedding-3-large at 1024 dims — see
-- schema.ts `vector` custom type). HNSW is the cheap ANN path on Neon.

CREATE TABLE IF NOT EXISTS pattern_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  error_fingerprint TEXT NOT NULL,
  embedding vector(1024),
  fix_strategy TEXT,
  -- short natural-language label: 'null-check-add' | 'import-fix' | ...
  files_touched JSONB NOT NULL DEFAULT '[]'::jsonb,
  success_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  confidence REAL,
  post_merge_health_score REAL,
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE pattern_memory
    ADD CONSTRAINT pattern_memory_success_count_non_negative
    CHECK (success_count >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE pattern_memory
    ADD CONSTRAINT pattern_memory_confidence_range
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE pattern_memory
    ADD CONSTRAINT pattern_memory_health_range
    CHECK (post_merge_health_score IS NULL OR (post_merge_health_score >= 0 AND post_merge_health_score <= 1));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A project + fingerprint pair should be unique; retries update in place.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pattern_memory_project_fingerprint
  ON pattern_memory (project_id, error_fingerprint);

-- Cosine ANN index on the embedding for Tier 0 lookup. Same HNSW params as
-- code_chunks so operators tuning one tune both.
CREATE INDEX IF NOT EXISTS idx_pattern_memory_embedding
  ON pattern_memory USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_pattern_memory_project_last_used
  ON pattern_memory (project_id, last_used_at DESC NULLS LAST)
  WHERE disabled_at IS NULL;
