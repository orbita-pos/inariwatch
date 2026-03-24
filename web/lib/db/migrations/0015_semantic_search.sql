-- Semantic search: enable trigram extension for fuzzy text matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram index on pattern_text for fast similarity search
CREATE INDEX IF NOT EXISTS "idx_patterns_text_trgm"
  ON "error_patterns" USING gin ("pattern_text" gin_trgm_ops);

-- Index for trending queries (occurrence count + recency)
CREATE INDEX IF NOT EXISTS "idx_patterns_trending"
  ON "error_patterns" ("occurrence_count" DESC, "last_seen_at" DESC);
