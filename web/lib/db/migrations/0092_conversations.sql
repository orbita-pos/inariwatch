-- Inari Live V1 — Session 5: conversation lifecycle.
--
-- Two tables that turn the chat-first product model into a SSOT:
--   * `conversations` — one row per alert thread (anchored) OR free chat
--     (anchor null). Drives the inbox sidebar + cross-device sync.
--   * `conversation_messages` — append-only log per conversation. Server
--     stamps a witness chain (BLAKE3 prev → curr) so `/witness verify`
--     at the conversation level can detect tampering across the whole
--     thread, not just per-tool-call as S6 already does.
--
-- Decisions (per INARI_LIVE_V1_PLAN.md → "Conversations / chat-first model"):
--   * Alert = conversation. Idempotent on `anchor_alert_id` so a re-fired
--     webhook for the same fingerprint never spawns a duplicate thread.
--   * Last-write-wins per turn for cross-device messages — race is rare,
--     and `postUserMessage` retries with the freshest `prev_message_hash`
--     when two devices try to chain off the same row simultaneously.
--   * State CHECK (not Postgres ENUM) so future additions ship as a
--     one-line swap instead of a `ALTER TYPE ADD VALUE` dance.
--
-- Schema notes:
--   * `workspace_id` is nullable for legacy single-org installs (matches
--     `projects.workspace_id` shape). Acceptance tests cover both paths.
--   * `prev_message_hash` / `message_hash` are NULLable on row insert so
--     the chain seeder can stamp them in a separate update inside the
--     same transaction — keeps the INSERT statement focused on the
--     business payload and lets the chain logic live in TypeScript.
--   * `active_device_id` mirrors the auth `device_tokens.device_id` UUID
--     but without an FK so deleting a device doesn't cascade-delete
--     conversation history.

CREATE TABLE IF NOT EXISTS "conversations" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"        uuid REFERENCES "organizations"("id") ON DELETE CASCADE,
  "anchor_alert_id"     uuid REFERENCES "alerts"("id") ON DELETE SET NULL,
  "state"               text NOT NULL DEFAULT 'active',
  "title"               text NOT NULL,
  "last_message_at"     timestamptz NOT NULL DEFAULT now(),
  "snoozed_until"       timestamptz,
  "resolved_at"         timestamptz,
  "resolution_summary"  text,
  "created_by_user_id"  uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "active_device_id"    uuid,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_state_chk'
  ) THEN
    ALTER TABLE "conversations"
      ADD CONSTRAINT "conversations_state_chk"
      CHECK ("state" IN ('active', 'snoozed', 'resolved', 'archived'));
  END IF;
END $$;

-- Idempotency: one conversation per anchor alert. Re-firing a webhook
-- with the same fingerprint is already deduped at `createAlertIfNew`,
-- so this index belt-and-suspenders that promise.
CREATE UNIQUE INDEX IF NOT EXISTS "conversations_anchor_alert_uniq"
  ON "conversations"("anchor_alert_id")
  WHERE "anchor_alert_id" IS NOT NULL;

-- Sidebar inbox query — ordered by recent activity within (workspace, state).
CREATE INDEX IF NOT EXISTS "conversations_workspace_state_idx"
  ON "conversations"("workspace_id", "state", "last_message_at" DESC);

-- Snooze sweeper — wakes snoozed conversations whose `snoozed_until` has passed.
CREATE INDEX IF NOT EXISTS "conversations_snooze_idx"
  ON "conversations"("snoozed_until")
  WHERE "state" = 'snoozed' AND "snoozed_until" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "conversation_messages" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversation_id"    uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "role"               text NOT NULL,
  "content_json"       jsonb NOT NULL,
  "tool_call_id"       text,
  "created_at"         timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "device_id"          uuid,
  "prev_message_hash"  text,
  "message_hash"       text
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversation_messages_role_chk'
  ) THEN
    ALTER TABLE "conversation_messages"
      ADD CONSTRAINT "conversation_messages_role_chk"
      CHECK ("role" IN ('user', 'assistant', 'tool', 'system'));
  END IF;
END $$;

-- Thread fetch — order messages within a conversation chronologically.
CREATE INDEX IF NOT EXISTS "conversation_messages_conv_idx"
  ON "conversation_messages"("conversation_id", "created_at");
