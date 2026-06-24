-- 0006_events_indices: index for retention runner.
--
-- The pre-existing indices `events_repo_kind_ts_idx (repo_id, kind, timestamp)`
-- and `events_ts_idx (timestamp)` cover repo-scoped reads + global time
-- ordering. The retention runner (Sesión 13) runs `WHERE kind = ? AND
-- timestamp < ?` per kind across all repos — neither pre-existing index
-- has `kind` as the leading column, so SQLite would fall back to a full
-- scan. A small `(kind, timestamp)` index keeps the per-tick cost O(log n)
-- even when the table grows into the millions.

CREATE INDEX IF NOT EXISTS events_kind_ts_idx ON events(kind, timestamp);
