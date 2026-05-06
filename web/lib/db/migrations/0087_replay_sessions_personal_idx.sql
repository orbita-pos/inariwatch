-- 0087 — partial index on replay_sessions for personal-workspace lookups.
--
-- The dashboard list at /sessions, when viewed by a user in a personal
-- workspace (no active organization), runs:
--
--   SELECT ... FROM replay_sessions
--   WHERE organization_id IS NULL AND user_id = $1
--   ORDER BY started_at DESC
--   LIMIT N OFFSET M
--
-- A partial index on (user_id, started_at DESC) WHERE organization_id IS
-- NULL keeps that query cheap as the table grows. The full table is
-- already partitioned in practice by the existing org-scoped index, so
-- this partial index is small and only covers personal sessions.
--
-- Idempotent. CONCURRENTLY = no lock on the table during creation, safe
-- to run on a live DB. Cannot live in a transaction — runner script
-- must execute it outside the implicit BEGIN/COMMIT (the .ts runner does
-- this by default since neon HTTP is autocommit-per-statement).

CREATE INDEX CONCURRENTLY IF NOT EXISTS replay_sessions_user_personal_idx
  ON replay_sessions (user_id, started_at DESC)
  WHERE organization_id IS NULL;

COMMENT ON INDEX replay_sessions_user_personal_idx IS
  'Personal-workspace list lookup. Partial: only sessions with NULL org. Migration 0087.';
