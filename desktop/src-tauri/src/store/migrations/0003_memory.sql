-- 0003_memory: declarative `memory.md` versions + procedural patterns.
--
-- `memory_md_versions` is append-only — every write produces a new row
-- so users can audit / rollback. Session 11 owns the writer.
-- `patterns` is upserted by fingerprint per repo; demotion to
-- anti-pattern flips kind in place. Session 12 owns the matcher.

CREATE TABLE memory_md_versions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id     TEXT    NOT NULL,
    content     TEXT    NOT NULL,
    written_by  TEXT    NOT NULL,
    written_at  INTEGER NOT NULL,
    FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
);
CREATE INDEX memory_md_repo_ts_idx ON memory_md_versions(repo_id, written_at DESC);

CREATE TABLE patterns (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id       TEXT    NOT NULL,
    pattern_kind  TEXT    NOT NULL,
    fingerprint   TEXT    NOT NULL,
    evidence      TEXT    NOT NULL,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    last_seen_at  INTEGER NOT NULL,
    FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE,
    UNIQUE (repo_id, fingerprint)
);
CREATE INDEX patterns_repo_kind_idx ON patterns(repo_id, pattern_kind);
