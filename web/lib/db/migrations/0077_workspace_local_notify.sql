-- v0.3 S3 — workspace flag for routing notify.compose.email to user-sidecar
--
-- Per `INARI_AI_ARCHITECTURE.md` §6.3 + the v0.3 S3 handoff: workspaces opt
-- in to running notification composition on Inari Live (their local
-- machine). Default OFF — every existing customer keeps cloud routing
-- until they flip the toggle in Settings → AI Preferences.
--
-- The router (`packages/ai-router/src/rules.ts:resolvePrimary`) reads
-- `workspace.preferences.localNotifyEnabled` against the rule's
-- `workspaceFlag`. When the column is false the router returns the
-- rule's `fallback` target (cloud) — byte-identical to pre-S3 behavior.
--
-- Future S4/S5 sessions add `local_chat_enabled`, `capture_redact_enabled`
-- alongside this column. They follow the same default-off invariant.
--
-- Rollback:
--   ALTER TABLE organizations DROP COLUMN IF EXISTS local_notify_enabled;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS local_notify_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN organizations.local_notify_enabled IS
  'v0.3 S3 — when true, notify.compose.email dispatches route to Inari Live (user-sidecar) instead of cloud. Default false. Sidecar offline / timeout falls back to cloud transparently per ai-router rule fallback.';
