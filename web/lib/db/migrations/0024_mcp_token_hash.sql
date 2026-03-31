-- MCP token security: hash tokens + add expiration

-- Add token_hash column (will hold SHA-256 hash of token)
ALTER TABLE "mcp_tokens" ADD COLUMN IF NOT EXISTS "token_hash" text;

-- Add expiration column
ALTER TABLE "mcp_tokens" ADD COLUMN IF NOT EXISTS "expires_at" timestamptz;

-- Hash all existing plaintext tokens
UPDATE "mcp_tokens" SET "token_hash" = encode(sha256(("token")::bytea), 'hex') WHERE "token" IS NOT NULL AND "token_hash" IS NULL;

-- Make token_hash unique and not null (after backfill)
-- Note: IF NOT EXISTS not supported for constraints, use DO block
DO $$ BEGIN
  ALTER TABLE "mcp_tokens" ALTER COLUMN "token_hash" SET NOT NULL;
EXCEPTION WHEN others THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_mcp_tokens_hash" ON "mcp_tokens" ("token_hash");

-- Drop the plaintext token column
ALTER TABLE "mcp_tokens" DROP COLUMN IF EXISTS "token";

-- Drop old plaintext index
DROP INDEX IF EXISTS "idx_mcp_tokens_token";
