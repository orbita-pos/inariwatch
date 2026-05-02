-- v0.3 S2.5 — AI router receipts mirror table
--
-- Persistent sink for `RouterReceipt` events emitted by every dispatch through
-- @inariwatch/ai-router. Phase 1 (S1) wired only an in-memory sink; this
-- migration adds the durable mirror that powers /admin/ops widgets and lets
-- post-hoc audits recover the substrate / provider / latency breakdown.
--
-- One row per dispatch. Truncated to 14 days by an existing retention cron
-- (added in S3 alongside `localNotifyEnabled` rollout). For now rows live
-- forever — at <1k req/day the table stays under 200MB for >6 months and
-- gives us pre-launch headroom to tune the retention policy.
--
-- Per architecture §12 (LOCKED 2026-05-02), receipts capture WHO, WHERE,
-- and WHAT for every AI action — including which Ed25519 key signed (cloud
-- vs user-sidecar). The dual JSONB columns let us round-trip both signed
-- payloads without cross-talking the cloud + sidecar chains.
--
-- Rollback:
--   DROP TABLE IF EXISTS ai_router_receipts;

CREATE TABLE IF NOT EXISTS ai_router_receipts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- "workspace" is the user-facing name for `organizations` rows in this
  -- monorepo. FK keeps cascade-delete consistent when an org is removed.
  workspace_id    uuid REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid,
  project_id      uuid,
  alert_id        uuid,
  remediation_session_id uuid,

  -- Task name (taxonomy in packages/ai-router/src/tasks.ts).
  task            text NOT NULL,
  -- Top-level namespace: 'code' | 'alert' | 'notify' | 'voice' | 'chat' | 'redact' | 'gate'.
  namespace       text NOT NULL,
  -- Substrate: 'cloud' | 'user-sidecar' | 'capture-embedded' | 'cli-linked'.
  substrate       text NOT NULL,
  -- Provider id ('claude' | 'openai' | 'groq' | 'grok' | 'deepseek' | 'gemini'
  -- | 'user-sidecar' | 'capture-embedded' | 'cli-linked'). Free-form text so
  -- adding a new provider doesn't require a CHECK constraint flip.
  provider        text NOT NULL,
  model           text NOT NULL,

  input_tokens    integer,
  output_tokens   integer,
  cached_input_tokens integer,
  duration_ms     integer NOT NULL,

  -- 'direct' (same-process / cloud) | 'relay' (over relay.inariwatch.com).
  relay_path      text,

  -- True when the dispatch fell back from primary → fallback target.
  fallback_used   boolean NOT NULL DEFAULT false,
  -- True when PLATFORM_AI_KEY was used (vs workspace BYOK).
  is_platform_key boolean NOT NULL DEFAULT false,

  -- Hex-encoded SHA-256 of canonical receipt body. Populated by sinks that
  -- do their own hashing (S4+); Phase-1 sinks leave NULL.
  eap_chain_root  text,
  -- Raw user-Ed25519-signed receipt when substrate='user-sidecar' (S27/28
  -- chain). NULL otherwise.
  user_sidecar_receipt jsonb,
  -- Cloud-signed receipt body when substrate='cloud'. NULL when the cloud
  -- sink emits metadata-only (Phase 1).
  cloud_receipt   jsonb,

  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_router_receipts_workspace_created_idx
  ON ai_router_receipts (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ai_router_receipts_substrate_created_idx
  ON ai_router_receipts (substrate, created_at DESC);

CREATE INDEX IF NOT EXISTS ai_router_receipts_task_created_idx
  ON ai_router_receipts (task, created_at DESC);

CREATE INDEX IF NOT EXISTS ai_router_receipts_namespace_created_idx
  ON ai_router_receipts (namespace, created_at DESC);

COMMENT ON TABLE ai_router_receipts IS
  'v0.3 S2.5 — durable mirror of @inariwatch/ai-router RouterReceipt events. One row per dispatch. Drives /admin/ops widgets (substrate breakdown, p50/p95 latency, fallback count) and audit replays. Per architecture §12 the receipt is the verifiable trail of every AI action.';

COMMENT ON COLUMN ai_router_receipts.user_sidecar_receipt IS
  'Raw user-Ed25519-signed receipt the sidecar emits when substrate=user-sidecar (S27/S28 chain). Persisted AS-IS — never re-signed by web.';
