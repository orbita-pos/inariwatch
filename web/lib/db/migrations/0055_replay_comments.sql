-- Day 4 — Comments anchored to a replay timestamp.
--
-- Threading: 1-level via `parent_id`; the API rejects nested replies
-- (parent of a parent) so the UI never has to deal with deep recursion.
--
-- Soft-delete: a deleted comment keeps the row + clears `body` to '[deleted]'
-- so reply threads still render coherently. We could hard-delete top-level
-- comments with no replies, but the bookkeeping isn't worth it.
--
-- Auth: enforced at the route layer — anyone who can read the session
-- (org owner OR member) can read + post comments. Edits/deletes are
-- self-only within 5 min (Slack-style).

CREATE TABLE IF NOT EXISTS replay_comments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      text NOT NULL REFERENCES replay_sessions(session_id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id)             ON DELETE CASCADE,
  timestamp_ms    integer NOT NULL CHECK (timestamp_ms >= 0),
  body            text NOT NULL,
  parent_id       uuid REFERENCES replay_comments(id)            ON DELETE CASCADE,
  resolved        boolean NOT NULL DEFAULT false,
  -- Mentioned user ids (resolved at create time). Stored on the row so
  -- the dashboard list can render avatars without a join per comment.
  mentioned_user_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Drives "all comments for this session ordered by timestamp" — the only
-- read path the panel uses.
CREATE INDEX IF NOT EXISTS replay_comments_session_idx
  ON replay_comments (session_id, timestamp_ms);

-- Drives "@me mentions" inbox in a future iteration. Cheap to add now
-- since the column exists.
CREATE INDEX IF NOT EXISTS replay_comments_mentions_idx
  ON replay_comments USING GIN (mentioned_user_ids);
