-- Session 1 — Inari Live device tokens.
--
-- Per-device auth tokens for Inari Live (Tauri desktop) installs. Replaces
-- the single-row api_keys.service='desktop' model that DELETE-then-INSERTed
-- on every approval, breaking multi-device.
--
-- Decisions (per INARI_LIVE_V1_PLAN.md → "Authentication & devices"):
--   * Each device gets its own token, revocable individually.
--   * Hash-only storage (mcp_tokens pattern). Plaintext lives only in the
--     device's OS keyring — server never needs to recover it.
--   * Label auto-generated from hostname on first connect; user-renamable.
--   * "Sign out all devices" = bulk revoke of this table only. Project
--     tokens (S2's project_tokens table) are NOT touched here.
--
-- Backwards compatibility: pre-S1 desktop installs still authenticate via
-- the legacy api_keys path until they re-pair. authenticateExtensionToken()
-- falls back to api_keys when no device_tokens row matches.

CREATE TABLE device_tokens (
    device_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash    TEXT NOT NULL UNIQUE,
    label         TEXT NOT NULL,
    os            TEXT,
    hostname      TEXT,
    app_version   TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at    TIMESTAMPTZ
);

-- Active-device lookups by user (Settings → Devices list).
CREATE INDEX idx_device_tokens_user_active
    ON device_tokens (user_id, last_seen_at DESC)
    WHERE revoked_at IS NULL;

-- The UNIQUE on token_hash already gives us O(1) hash lookup. The partial
-- index below is an extra step ONLY for the hot path (Bearer auth on every
-- /api/desktop/* request) so revoked rows don't slow the planner.
CREATE INDEX idx_device_tokens_hash_active
    ON device_tokens (token_hash)
    WHERE revoked_at IS NULL;
