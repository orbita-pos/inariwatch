-- 0013 — `tool_invocations.source` column for the slash-command trail.
--
-- Adds an attribution column distinguishing what kicked off the
-- invoke pipeline:
--   "agent"   — the LLM decided to call the tool (default).
--   "slash"   — the user typed a /<command> in chat. The slash IPC
--               (`desktop_tool_invoke_via_slash`) bypasses Confirm but
--               still respects per-tool Deny overrides.
--   "manual"  — reserved. Future split for [Confirm] button clicks
--               in the chat UI; today those still record as "agent".
--   "scheduled" — reserved. Future cron / tray Quick Action triggers.
--
-- The S11 audit-log viewer renders `source` as a small pill on each
-- row so the human reading the chain can tell at a glance whether
-- the agent or the user kicked off a particular tool call. The
-- Witness receipt is unchanged — `source` is metadata about
-- attribution, not part of the cryptographic chain.
--
-- DEFAULT 'agent' so every existing row backfills cleanly. NOT NULL
-- because the audit log invariant is "every row has a source"; rows
-- without one are a bug.

ALTER TABLE tool_invocations
    ADD COLUMN source TEXT NOT NULL DEFAULT 'agent';

CREATE INDEX IF NOT EXISTS tool_invocations_source_idx
    ON tool_invocations (source, started_at_ms DESC);
