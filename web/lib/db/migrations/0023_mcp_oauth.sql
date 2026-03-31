-- MCP OAuth 2.1 PKCE authorization codes (ephemeral, 10-min TTL)
CREATE TABLE IF NOT EXISTS "mcp_oauth_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" text NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "client_id" text NOT NULL,
  "code_challenge" text NOT NULL,
  "redirect_uri" text NOT NULL,
  "scopes" text[] NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "mcp_oauth_codes_code_unique" UNIQUE ("code")
);
