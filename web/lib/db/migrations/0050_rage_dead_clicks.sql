-- Phase E — store frustration-signal arrays (rage clicks + dead clicks)
-- alongside each replay session. Both are small (<5KB typical) and always
-- read with the session, so jsonb on the row is the right pattern (matches
-- ai_chapters). Default '[]' so old rows stay valid + new code can iterate
-- without null checks.

ALTER TABLE replay_sessions
  ADD COLUMN IF NOT EXISTS rage_clicks jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS dead_clicks jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Functional indexes on the array length so the Phase D filter toggles
-- (`hasRageClicks`, `hasDeadClicks`) can be answered without scanning the
-- jsonb itself. Both predicates resolve to `> 0` so a btree on the count
-- expression is sufficient.
CREATE INDEX IF NOT EXISTS replay_sessions_rage_count_idx
  ON replay_sessions ((jsonb_array_length(rage_clicks)));

CREATE INDEX IF NOT EXISTS replay_sessions_dead_count_idx
  ON replay_sessions ((jsonb_array_length(dead_clicks)));
