-- MCP access tokens for remote MCP server authentication
CREATE TABLE IF NOT EXISTS "mcp_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "token" text NOT NULL,
  "scopes" text[] DEFAULT '{read}',
  "last_used_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "mcp_tokens_token_unique" UNIQUE ("token")
);

CREATE INDEX IF NOT EXISTS "idx_mcp_tokens_user" ON "mcp_tokens" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_mcp_tokens_token" ON "mcp_tokens" ("token");
