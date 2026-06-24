-- Inari Live Phase 5.2 — recent-paths ring buffer.
--
-- Stores the absolute repo paths the user has recently installed
-- `@inariwatch/capture` into (or otherwise interacted with via
-- `/install`). Powers the Phase 5.6 PathPickerSlot so users can pick
-- "the project I was just working on" without re-typing the absolute
-- path.
--
-- Capped at 20 entries by the touch_recent_path() helper in
-- `store::recent_paths`. Eviction is by `last_used_at` ascending —
-- we drop the least-recently-used rows above the cap. The cap is set
-- so the picker can render the full set as a list without paging.

CREATE TABLE recent_paths (
  path          TEXT    PRIMARY KEY,
  last_used_at  INTEGER NOT NULL
);

CREATE INDEX recent_paths_last_used_idx
  ON recent_paths(last_used_at DESC);
