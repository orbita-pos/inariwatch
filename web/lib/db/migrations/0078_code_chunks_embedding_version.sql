-- Code Intelligence v2 — Phase 0.1
-- Track which embedding model produced each code_chunks row.
-- Lets v2 coexist with v1, allows safe model swaps without truncating, and surfaces
-- divergence in the v1↔v2 A/B harness (Phase 3) when the same chunk gets different
-- embeddings depending on the active model.
--
-- Default 'voyage-code-3' matches the current production behavior in
-- web/lib/code-intelligence/embeddings.ts: Voyage Code 3 (1024 dim) is the primary
-- provider, OpenAI text-embedding-3-small (truncated to 1024) is the fallback.
-- Existing rows are stamped with the default; new rows must declare their model
-- via web/lib/code-intelligence/embeddings.ts:resolveEmbeddingModelLabel().
--
-- Backwards compatible: NOT NULL DEFAULT means inserts without the column still work.

ALTER TABLE "code_chunks"
  ADD COLUMN IF NOT EXISTS "embedding_model_version" text NOT NULL DEFAULT 'voyage-code-3';

CREATE INDEX IF NOT EXISTS "idx_code_chunks_embedding_model"
  ON "code_chunks" ("repo_id", "embedding_model_version");
