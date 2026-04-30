-- 0002_embeddings: code symbols + sqlite-vec virtual table.
--
-- Embedding dimension is 384 — MiniLM-L6-v2 (Session 6 spec).
-- HANDOFF.md mentions 1024 in Session 3's spec block but Session 6's
-- block is the source of truth on the model. See INARI_LIVE_DECISIONS.md
-- "Sesión 3 — embedding dimension".
--
-- The vec0 module is loaded on every connection via
-- sqlite_vec::sqlite3_vec_init (see store/pool.rs).

CREATE TABLE code_symbols (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id      TEXT    NOT NULL,
    file_path    TEXT    NOT NULL,
    symbol_name  TEXT    NOT NULL,
    kind         TEXT    NOT NULL,
    line_start   INTEGER NOT NULL,
    line_end     INTEGER NOT NULL,
    ast_hash     TEXT    NOT NULL,
    FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE,
    UNIQUE (repo_id, file_path, symbol_name, line_start)
);
CREATE INDEX code_symbols_repo_file_idx ON code_symbols(repo_id, file_path);

CREATE VIRTUAL TABLE code_embeddings USING vec0(
    symbol_id INTEGER PRIMARY KEY,
    embedding FLOAT[384]
);
