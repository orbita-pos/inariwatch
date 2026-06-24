-- v0.3 S2 — chat-agent tool registry audit log.
--
-- Every `ToolRegistry::invoke` call writes one row here, regardless of
-- outcome (success, exec failure, schema invalid, permission denied).
-- The S11 audit-log viewer reads this table; the Witness sidecar
-- (linked by `witness_receipt_id`, content-addressed) provides the
-- cryptographic side of the trail.
--
-- Local-only — the cloud `audit_logs` table on the InariWatch web side
-- tracks workspace-scoped events. This table tracks per-user desktop
-- agent activity and is not synced.
--
-- Columns:
--   id                  invocation UUID, also the FK back into the
--                       Witness sidecar / EAP chain
--   tool_name           ToolMeta.name (namespaced, e.g. desktop.open_in_editor)
--   session_id          optional chat-session correlation id
--   args_json           args as the model emitted them, post schema-validation
--   result_json         tool's structured output (NULL on failure)
--   permission          effective level the resolver saw at invoke time
--                       (`auto` | `confirm` | `deny`)
--   permission_decision what the resolver returned
--                       (`allow` | `requires_confirm` | `denied`)
--   witness_receipt_id  hash of the Witness receipt; FK by hash so we
--                       can land cloud receipt mirrors later without
--                       schema churn
--   started_at_ms       UNIX ms at registry-entry
--   finished_at_ms      UNIX ms at registry-exit (post-execute or
--                       post-permission-denial)
--   success             0/1 boolean (sqlite has no native bool)
--   error               human message when success = 0
--
-- Indexes:
--   tool + recency      audit-log "show me last 50 desktop.run_shell"
--   session + recency   audit-log "show me everything in this chat"

CREATE TABLE IF NOT EXISTS tool_invocations (
    id                  TEXT    PRIMARY KEY,
    tool_name           TEXT    NOT NULL,
    session_id          TEXT,
    args_json           TEXT    NOT NULL,
    result_json         TEXT,
    permission          TEXT    NOT NULL,
    permission_decision TEXT    NOT NULL,
    witness_receipt_id  TEXT,
    started_at_ms       INTEGER NOT NULL,
    finished_at_ms      INTEGER NOT NULL,
    success             INTEGER NOT NULL,
    error               TEXT
);

CREATE INDEX IF NOT EXISTS tool_invocations_tool_idx
    ON tool_invocations (tool_name, started_at_ms DESC);

CREATE INDEX IF NOT EXISTS tool_invocations_session_idx
    ON tool_invocations (session_id, started_at_ms DESC);
