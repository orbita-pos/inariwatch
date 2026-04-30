-- 0001_initial: repos + events + settings.
--
-- All timestamps are unix epoch milliseconds (i64). Repo ids are
-- caller-generated (UUID v4 today; see store::queries::upsert_repo).
-- Events are append-only with a per-repo cascade on delete so wiping
-- a repo also wipes its history.

CREATE TABLE repos (
    id                  TEXT    PRIMARY KEY,
    path                TEXT    NOT NULL UNIQUE,
    name                TEXT    NOT NULL,
    opened_at           INTEGER NOT NULL,
    last_indexed_at     INTEGER,
    indexed_file_count  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX repos_path_idx ON repos(path);

CREATE TABLE events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    kind      TEXT    NOT NULL,
    repo_id   TEXT,
    payload   TEXT    NOT NULL,
    FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
);
CREATE INDEX events_repo_kind_ts_idx ON events(repo_id, kind, timestamp DESC);
CREATE INDEX events_ts_idx ON events(timestamp DESC);

CREATE TABLE settings (
    key        TEXT    PRIMARY KEY,
    value      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
);
