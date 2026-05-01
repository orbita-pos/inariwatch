-- Sesión 21 (Inari Live v0.2 — local AI track) — local model registry.
--
-- Tracks every GGUF model the daemon has downloaded, verified, and
-- cached on disk. The on-disk path is implicit: each row's file lives
-- at `<app_local_data>/inari-live/models/<model_id>/<content_hash>.gguf`.
--
-- Hash algorithm: BLAKE3 (not SHA-256). The S21 spec body specifies
-- BLAKE3 — see INARI_LIVE_DECISIONS.md 2026-05-01 (Sesión 21) for the
-- column-name reconciliation with the legacy `sha256` field the table
-- summary in INARI_LIVE_V0_2_HANDOFF.md mentions.

CREATE TABLE local_models (
    model_id      TEXT    PRIMARY KEY,
    content_hash  TEXT    NOT NULL,                      -- hex BLAKE3 of the .gguf file
    hash_algo     TEXT    NOT NULL DEFAULT 'blake3',     -- future-proof if we swap algos
    size_bytes    INTEGER NOT NULL,
    downloaded_at INTEGER NOT NULL,                      -- unix ms
    last_used_at  INTEGER                                -- unix ms; NULL until first generate()
);

-- Seed `settings` rows that the LocalAI facade reads on boot. Values
-- live in the same key/value `settings` table Sesión 3 introduced —
-- there is no separate `local_ai_settings` table (see DECISIONS).
--
-- `local_ai_enabled`         — feature flag. Default OFF until the
--                              user opts in from Settings.
-- `local_ai_tier`            — last-detected hardware tier. Empty
--                              until the first probe; populated by
--                              `hardware::detect_tier()` on next boot.
-- `local_ai_default_model`   — model_id used when callers don't pass
--                              one (Tab handler will set this in S23).
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
    ('local_ai_enabled',       'false', strftime('%s','now') * 1000),
    ('local_ai_tier',          '',      strftime('%s','now') * 1000),
    ('local_ai_default_model', '',      strftime('%s','now') * 1000);
