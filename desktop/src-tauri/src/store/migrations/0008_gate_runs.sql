-- Migration 0008 — gate_runs (Sesión 20)
--
-- Audit trail for every pre-push gate evaluation. The Go-rolled hooks.rs
-- handler (Sesión 8) inserts one row per `pre_push` event after the
-- async runner (`gates::runner`) returns its verdict, OR immediately
-- with `override_used = 1` when the user bypassed via `INARI_BYPASS=1`
-- on the request.
--
-- Schema notes:
--   * `run_id`           — UUID v4 caller-generated; mirrors the runner
--                          + bus event correlation key.
--   * `repo_id`          — soft FK; we don't ON DELETE CASCADE because
--                          the audit trail must survive a repo's removal.
--   * `allowed`          — final verdict the HTTP handler returned.
--   * `blocking_gates`   — JSON-encoded array of gate names that voted
--                          `false`. Empty `[]` when allowed=1.
--   * `individual_verdicts` — JSON-encoded full verdict bundle (the
--                          `Vec<GateVerdict>` the runner produced) so
--                          future tooling (dock list, web export) can
--                          render the per-gate detail without re-running.
--   * `total_latency_ms` — wall clock for the runner's parallel join.
--                          0 when the run was bypassed before spawning.
--   * `override_used`    — 1 when the user pushed via `INARI_BYPASS=1`
--                          (HTTP header `X-Inari-Bypass: 1` or post-hoc
--                          `request_bypass` IPC).
--   * `override_reason`  — optional free-text reason supplied to the
--                          `request_bypass` IPC. NULL when override
--                          came from the hook header (no reason flow).

CREATE TABLE IF NOT EXISTS gate_runs (
    run_id              TEXT    PRIMARY KEY,
    repo_id             TEXT    NOT NULL,
    sha                 TEXT    NOT NULL,
    ref_                TEXT    NOT NULL,
    allowed             INTEGER NOT NULL,
    blocking_gates      TEXT    NOT NULL DEFAULT '[]',
    individual_verdicts TEXT    NOT NULL DEFAULT '[]',
    total_latency_ms    INTEGER NOT NULL DEFAULT 0,
    created_at          INTEGER NOT NULL,
    override_used       INTEGER NOT NULL DEFAULT 0,
    override_reason     TEXT
);

CREATE INDEX IF NOT EXISTS gate_runs_repo_created_idx
    ON gate_runs (repo_id, created_at DESC);
