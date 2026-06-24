CREATE TABLE IF NOT EXISTS "telegram_user_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "telegram_user_id" text NOT NULL,
  "chat_id" text NOT NULL,
  "bot_token" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_telegram_links_tg_user" ON "telegram_user_links" ("telegram_user_id");
