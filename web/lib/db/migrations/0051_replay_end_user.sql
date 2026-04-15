-- Phase F — end-user identification on replay sessions.
--
-- Columns are nullable: sessions captured before the SDK upgrade (or from
-- pages where the customer never sets `window.__INARIWATCH_USER__`) keep
-- displaying as "anonymous" without any backfill.
--
-- email_hash (sha256 lowercased trimmed) is populated at ingest ALONGSIDE
-- the plain email so flipping the project's `hash_end_user_emails` privacy
-- toggle is instant in the dashboard — no re-render, no re-process.
--
-- Index on (project_id, end_user_id) backs:
--   * "show me all sessions for this user" (player → list link)
--   * the dashboard filter `?endUserId=...`

ALTER TABLE replay_sessions
  ADD COLUMN IF NOT EXISTS end_user_id         text,
  ADD COLUMN IF NOT EXISTS end_user_email      text,
  ADD COLUMN IF NOT EXISTS end_user_email_hash text;

CREATE INDEX IF NOT EXISTS replay_sessions_end_user_idx
  ON replay_sessions (project_id, end_user_id)
  WHERE end_user_id IS NOT NULL;
