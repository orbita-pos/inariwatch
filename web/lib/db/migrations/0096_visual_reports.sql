-- Visual Reports — user-initiated "report visual bug" submissions.
--
-- Distinct from auto-captured exceptions (which already flow through
-- /api/webhooks/capture and may include a screenshot for fire-and-
-- forget Kimi K2.6 analysis). Visual reports are EXPLICIT user submits
-- carrying rich diagnostic context (DOM snapshot, React fiber state,
-- console + network rings, source-map build id, user events, perf
-- metrics) and go through a 3-phase AI pipeline:
--
--   Phase A — TRIAGE   (Qwen3.5-9B vision, ~$0.0006/call)
--             "Is this a reproducible bug, intended behavior the user
--              misunderstood, or insufficient evidence?"
--   Phase B — DIAGNOSE (Qwen3.5-397B-A17B vision + thinking, ~$0.016)
--             Structured JSON with root_cause / evidence / hypotheses
--             / confidence / unknowns. Repo RAG context attached.
--             lookup_file tool prevents fabricated paths.
--   Phase C — CRITIQUE (Gemma 4 31B, ~$0.0015/call)
--             Different-family critic checks "does the proposed root
--             cause produce the visual symptom?" Breaks Qwen-family
--             correlated errors.
--
-- The diagnosis_json is the source of truth shipped to Inari Live. An
-- alerts row is created alongside so the report appears in the normal
-- alert feed with source='user_report'.

CREATE TABLE visual_reports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 1:1 with the alert created from this report. CASCADE keeps the
  -- visual_reports row alive only as long as the alert is.
  alert_id        UUID NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,

  -- Denormalized for fast project-scoped queries (e.g. workspace
  -- dashboard listing all visual reports in a project).
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Optional: which signed-in user submitted. Null when the report
  -- came from an anonymous end-user widget (Phase B of adoption).
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,

  -- ── Captured payload ────────────────────────────────────────────
  -- URL to screenshot blob in object storage (Hetzner Object Storage
  -- or R2 bucket). The blob itself lives outside Postgres.
  screenshot_url  TEXT NOT NULL,

  -- The captured context (DOM + React fiber + console + network +
  -- user events + perf + build_id + redaction stats). Stored as
  -- JSONB — gzipped on the wire, expanded at rest. Bounded by the
  -- upload endpoint to ≤500KB.
  bundle_json     JSONB NOT NULL,

  -- SHA-256 of canonicalized bundle_json. Used for dedup if the same
  -- user submits twice within seconds.
  bundle_hash     TEXT NOT NULL,

  -- Capture-time telemetry (how the SDK behaved on the user's machine).
  capture_ms      INTEGER,            -- wall-clock ms to gather bundle
  payload_size    INTEGER,            -- bytes uploaded (pre-decompression)
  redaction_stats JSONB,              -- { emails: n, tokens: n, cards: n, ... }

  -- ── Pipeline state ──────────────────────────────────────────────
  -- pending     → row inserted, AI pipeline not yet dispatched
  -- triaging    → Qwen3.5-9B in flight
  -- diagnosing  → Qwen3.5-397B in flight
  -- critiquing  → Gemma 4 31B in flight
  -- completed   → diagnosis shipped, confidence ≥ threshold
  -- rejected    → triage said "not a bug" OR critique said "doesn't match"
  -- need_info   → confidence < threshold, unknowns[] populated; user
  --               will be prompted to add detail
  -- failed      → pipeline errored (provider 5xx, schema parse, etc.)
  status          TEXT NOT NULL DEFAULT 'pending',
  error           TEXT,               -- only populated when status='failed'

  -- ── AI pipeline output ──────────────────────────────────────────
  -- Triage verdict from Phase A. Shape:
  --   { verdict: 'bug' | 'misunderstanding' | 'insufficient',
  --     reason: string, follow_up_question?: string }
  triage_result   JSONB,

  -- The full structured diagnosis from Phase B. Shape matches the
  -- visual-diagnosis Zod schema in web/lib/ai/schemas/. Key fields:
  --   { root_cause: { file, line, function, causal_chain },
  --     evidence: [{ claim, type, source, quote }],
  --     hypotheses_considered: [{ hypothesis, score, rejected_because }],
  --     confidence: 0..100,
  --     unknowns: string[],
  --     recommended_fix_hint: string }
  diagnosis       JSONB,

  -- Critique result from Phase C. Shape:
  --   { verdict: 'accept' | 'reject' | 'needs_more_context',
  --     reason: string,
  --     mismatch_evidence?: string }
  critique        JSONB,

  -- Final confidence after all 3 phases (gate at ≥75 by default to
  -- ship, <60 to ask for more info, intermediate falls back to
  -- agentic exploration in V0.5).
  confidence      INTEGER,

  -- ── Telemetry ───────────────────────────────────────────────────
  -- Which Together model IDs were actually invoked. Tracked because
  -- the router may swap them per-region or fallback on 429.
  model_triage    TEXT,
  model_diagnose  TEXT,
  model_critique  TEXT,
  cost_cents      INTEGER NOT NULL DEFAULT 0,
  duration_ms     INTEGER,            -- end-to-end pipeline duration

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot path: dashboard listing visual reports for a project, newest first.
CREATE INDEX visual_reports_project_idx
  ON visual_reports (project_id, created_at DESC);

-- Inari Live desktop polls/streams by alert id — 1:1 lookup must be cheap.
CREATE UNIQUE INDEX visual_reports_alert_idx
  ON visual_reports (alert_id);

-- Pipeline orchestrator scans for unfinished work.
CREATE INDEX visual_reports_active_status_idx
  ON visual_reports (status)
  WHERE status IN ('pending', 'triaging', 'diagnosing', 'critiquing');

-- Dedup: same bundle uploaded twice in quick succession (user accidentally
-- double-clicked submit). Same project + same bundle hash = same report.
CREATE INDEX visual_reports_dedup_idx
  ON visual_reports (project_id, bundle_hash, created_at DESC);

-- Standard updated_at trigger (same pattern as test_generation_sessions
-- in 0095, remediation_sessions, conversations).
CREATE OR REPLACE FUNCTION update_visual_reports_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER visual_reports_updated_at_trigger
  BEFORE UPDATE ON visual_reports
  FOR EACH ROW
  EXECUTE FUNCTION update_visual_reports_updated_at();
