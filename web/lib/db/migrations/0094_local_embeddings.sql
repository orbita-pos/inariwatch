-- Resize all vector columns 1024 → 768 to match nomic-embed-code output.
--
-- All three HNSW indexes must be dropped before the column type can change.
-- Existing vectors are dimensionally incompatible and are set to NULL —
-- a full re-index is required after applying this migration.
--
-- Affected tables:
--   code_chunks.embedding          (code intelligence search)
--   remediation_sessions.fix_embedding  (fix replay similarity)
--   pattern_memory.embedding       (tier-0 pattern lookup)

-- Drop HNSW indexes (required before ALTER COLUMN TYPE)
DROP INDEX IF EXISTS idx_code_chunks_embedding;
DROP INDEX IF EXISTS idx_remediation_fix_embedding;
DROP INDEX IF EXISTS idx_pattern_memory_embedding;

-- Nullify existing embeddings (1024-dim vectors are incompatible with vector(768))
UPDATE code_chunks SET embedding = NULL;
ALTER TABLE code_chunks ALTER COLUMN embedding TYPE vector(768);

UPDATE remediation_sessions SET fix_embedding = NULL;
ALTER TABLE remediation_sessions ALTER COLUMN fix_embedding TYPE vector(768);

UPDATE pattern_memory SET embedding = NULL;
ALTER TABLE pattern_memory ALTER COLUMN embedding TYPE vector(768);

-- Recreate HNSW indexes for the new dimension (same params as original)
CREATE INDEX IF NOT EXISTS idx_code_chunks_embedding
  ON code_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_remediation_fix_embedding
  ON remediation_sessions USING hnsw (fix_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_pattern_memory_embedding
  ON pattern_memory USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
