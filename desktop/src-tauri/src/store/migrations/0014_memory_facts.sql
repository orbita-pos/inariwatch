-- User memory facts — structured knowledge store for the AI.
--
-- Each row is one fact the AI has learned or been told about the user.
-- Typed by `fact_type` so the renderer can group and prioritize them.
-- `source` distinguishes things the user explicitly told the AI
-- ('explicit') from inferred behavioral patterns ('inferred') from
-- observed tool/alert usage ('observed').
--
-- `expires_at` is NULL for permanent facts (identity, preferences).
-- Context facts (current project, active bug) can be given a TTL so
-- stale context doesn't pollute future sessions.

CREATE TABLE memory_facts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_type     TEXT    NOT NULL
                CHECK(fact_type IN ('identity','preference','pattern','context','skill')),
  content       TEXT    NOT NULL,
  confidence    REAL    NOT NULL DEFAULT 0.9
                CHECK(confidence >= 0.0 AND confidence <= 1.0),
  source        TEXT    NOT NULL DEFAULT 'explicit'
                CHECK(source IN ('explicit','inferred','observed')),
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER           -- NULL = permanent
);

CREATE INDEX memory_facts_type_idx     ON memory_facts(fact_type);
CREATE INDEX memory_facts_last_seen_idx ON memory_facts(last_seen_at DESC);
