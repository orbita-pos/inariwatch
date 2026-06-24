-- v0.3 S8 — Inari Live messenger-as-UI pairing tables.
--
-- Backs `crate::pairing::PairingService`, the S12-ready primitive that
-- gates inbound DMs from third-party messengers (WhatsApp first; mobile
-- pairing lands in S12 reusing the SAME tables — `kind = "device"` is
-- already a valid value, no schema churn needed).
--
-- Two tables, both per-workspace and local-only (no cloud sync):
--
-- 1. `pending_pairings` — short-lived (<= 1h TTL) Crockford codes
--    waiting to be redeemed. The S8 UI renders these in
--    Settings → Channels → WhatsApp → Pair. When an inbound DM matches
--    `/pair CODE`, the row's `code` column is consumed and a
--    `paired_entity` row is born after SAS confirmation.
--
-- 2. `paired_entities` — the long-lived "this phone/device is allowed
--    to act as the user" record. Keyed by `(workspace_id, kind,
--    identifier)` because the same phone could pair against different
--    workspaces (one per company, future-proof for the upcoming
--    workspace-switcher).
--
-- The `kind` discriminator is a TEXT enum (`'phone' | 'device'`)
-- enforced via CHECK constraint — SQLite has no native enums but a
-- CHECK gets us the same compile-time guarantee as far as the data
-- layer cares.
--
-- Indexes are minimal on purpose: pending lookups are rare (only on
-- inbound `/pair`) and the active list is small (single-digit phones
-- per workspace). We index by `code` for the redeem path and by
-- `(workspace_id, revoked_at)` for the Settings list — those are the
-- only two hot paths.

CREATE TABLE IF NOT EXISTS pending_pairings (
    id              TEXT    PRIMARY KEY,        -- UUID v4 simple form
    code            TEXT    NOT NULL UNIQUE,    -- 8-char Crockford
    kind            TEXT    NOT NULL CHECK (kind IN ('phone', 'device')),
    workspace_id    TEXT    NOT NULL,
    initiator       TEXT    NOT NULL,           -- free-form ("user", future: actor id)
    created_at_ms   INTEGER NOT NULL,
    expires_at_ms   INTEGER NOT NULL            -- created_at_ms + 1h
);

CREATE INDEX IF NOT EXISTS pending_pairings_code_idx
    ON pending_pairings (code);

CREATE INDEX IF NOT EXISTS pending_pairings_workspace_idx
    ON pending_pairings (workspace_id, created_at_ms DESC);

CREATE TABLE IF NOT EXISTS paired_entities (
    id                TEXT    PRIMARY KEY,         -- UUID v4 simple form
    kind              TEXT    NOT NULL CHECK (kind IN ('phone', 'device')),
    display_name      TEXT    NOT NULL,
    identifier        TEXT    NOT NULL,            -- E.164 phone OR device pubkey base58
    workspace_id      TEXT    NOT NULL,
    paired_at_ms      INTEGER NOT NULL,
    last_seen_at_ms   INTEGER NOT NULL,
    revoked_at_ms     INTEGER,                     -- NULL while active
    -- Same identifier can be re-paired after a revoke; we filter by
    -- `revoked_at_ms IS NULL` on lookup rather than UNIQUE-constraining
    -- the (workspace, kind, identifier) tuple. The
    -- `paired_entities_active_idx` partial-index below makes that fast.
    UNIQUE (workspace_id, kind, identifier, paired_at_ms)
);

CREATE INDEX IF NOT EXISTS paired_entities_workspace_idx
    ON paired_entities (workspace_id, revoked_at_ms);

-- Hot path: "is this (channel, phone) paired?" — checked on every
-- inbound message before the AI loop. Partial index on the active rows
-- keeps the lookup constant-time even after a thousand revokes.
CREATE INDEX IF NOT EXISTS paired_entities_active_idx
    ON paired_entities (workspace_id, kind, identifier)
    WHERE revoked_at_ms IS NULL;
