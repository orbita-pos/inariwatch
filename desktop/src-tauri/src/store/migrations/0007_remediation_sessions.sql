-- Sesión 19 — local remediation history.
--
-- Persists each remediation session the orchestrator launches. State
-- transitions: pending → draft → applied | rejected | failed. The
-- single-shot path produces a `draft_diff`; the cloud-proxied path
-- produces a `pr_url` (the cloud creates its own branch + PR, no local
-- diff to display). Either column may be NULL until the session
-- completes.
--
-- `mode` is stored as TEXT (CHECK-constrained) instead of an enum so
-- adding a future tier (e.g. "container_agent") doesn't require a
-- migration. `state` is the same shape for the same reason — see
-- INARI_LIVE_DECISIONS.md 2026-05-01.
--
-- Cents are integers (no fractional cents — round at billing time).

CREATE TABLE IF NOT EXISTS remediation_sessions (
    id                 TEXT    PRIMARY KEY,
    repo_id            TEXT    NOT NULL,
    mode               TEXT    NOT NULL CHECK (mode IN ('local', 'cloud')),
    error_fingerprint  TEXT,
    error_message      TEXT,
    draft_diff         TEXT,
    files_touched      TEXT,
    pr_url             TEXT,
    commit_sha         TEXT,
    state              TEXT    NOT NULL DEFAULT 'pending'
                               CHECK (state IN ('pending', 'draft', 'applied', 'rejected', 'failed')),
    created_at         INTEGER NOT NULL,
    completed_at       INTEGER,
    prompt_tokens      INTEGER NOT NULL DEFAULT 0,
    completion_tokens  INTEGER NOT NULL DEFAULT 0,
    cents              INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
);

-- Listings sort by recency per repo. Default UI shows last 50 per repo.
CREATE INDEX IF NOT EXISTS remediation_sessions_repo_created_idx
    ON remediation_sessions(repo_id, created_at DESC);
