-- Phase 5 search indexes for replay_sessions.
-- urls_visited already holds normalized hrefs; GIN makes @> / && array ops
-- constant-time instead of sequential scan.

CREATE INDEX IF NOT EXISTS "idx_replay_sessions_urls"
  ON "replay_sessions" USING GIN ("urls_visited");

-- Trigram index on browser/os for prefix-match filter dropdowns (cheap).
-- Uses pg_trgm which Neon has enabled by default.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "idx_replay_sessions_browser_trgm"
  ON "replay_sessions" USING GIN ("browser" gin_trgm_ops) WHERE "browser" IS NOT NULL;
