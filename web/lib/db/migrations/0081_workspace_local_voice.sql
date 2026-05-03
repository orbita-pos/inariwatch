-- v0.3 S5 — workspace flag for routing voice.tts.* to user-sidecar (Piper)
--
-- Per `INARI_AI_ARCHITECTURE.md` §6.3 + the v0.3 S5 handoff: workspaces
-- opt in to running voice synthesis on Inari Live (Piper). Default OFF —
-- every existing customer keeps cloud routing (OpenAI tts-1) until they
-- flip the toggle in Settings → AI Preferences.
--
-- The router (`packages/ai-router/src/rules.ts:resolvePrimary`) reads
-- `workspace.preferences.localVoiceEnabled` against the rule's
-- `workspaceFlag`. When the column is false the router returns the
-- rule's `fallback` target (cloud) — byte-identical to pre-S5 behavior.
--
-- WhatsApp piggybacks on `local_notify_enabled` (added in 0077) — same
-- privacy invariant as email body composition. Voice gets its own flag
-- because it has different infra requirements (Piper binary + voice
-- models on disk; ~200MB if all four bundled languages are downloaded).
--
-- Rollback:
--   ALTER TABLE organizations DROP COLUMN IF EXISTS local_voice_enabled;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS local_voice_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN organizations.local_voice_enabled IS
  'v0.3 S5 — when true, voice.tts.* dispatches route to Inari Live (Piper) instead of cloud OpenAI tts-1. Default false. Sidecar offline / timeout falls back to cloud transparently per ai-router rule fallback.';
