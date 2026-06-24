-- Fix replay: add embedding column to remediation_sessions for vector similarity search
ALTER TABLE "remediation_sessions" ADD COLUMN IF NOT EXISTS "fix_embedding" vector(1024);

-- HNSW index for fast approximate nearest neighbor search
CREATE INDEX IF NOT EXISTS "idx_remediation_fix_embedding" ON "remediation_sessions"
  USING hnsw ("fix_embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);
