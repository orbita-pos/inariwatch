-- Add SHA-256 hash column for O(1) token auth lookup (replaces O(n) decrypt scan)
ALTER TABLE "api_keys" ADD COLUMN "key_hash" text;
CREATE UNIQUE INDEX "api_keys_key_hash_idx" ON "api_keys" ("key_hash") WHERE "key_hash" IS NOT NULL;
