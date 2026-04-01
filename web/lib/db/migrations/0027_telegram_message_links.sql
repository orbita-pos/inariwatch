-- Telegram message tracking for thread context (equivalent to slackMessageThreads)
CREATE TABLE IF NOT EXISTS "telegram_message_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "chat_id" text NOT NULL,
  "message_id" integer NOT NULL,
  "alert_id" uuid REFERENCES "alerts"("id") ON DELETE CASCADE,
  "storm_id" uuid REFERENCES "incident_storms"("id") ON DELETE CASCADE,
  "type" text NOT NULL DEFAULT 'alert',
  "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_tg_msg_links_alert" ON "telegram_message_links" ("alert_id");
CREATE INDEX IF NOT EXISTS "idx_tg_msg_links_chat" ON "telegram_message_links" ("chat_id", "message_id");
