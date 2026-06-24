-- S12 — mobile pairing (chat-agent PWA replacing the deprecated bot-app/).
--
-- Two tables back the pairing flow described in S12_PROMPT.md §3
-- (Option A — web-driven, eventually consistent with desktop SQLite).
--
-- `mobile_pairing_challenges` — one row per active pairing attempt.
-- Created when the desktop announces a fresh Crockford code via the
-- `/api/mobile/pair/_announce` webhook, then upgraded to "redeemed"
-- when mobile POSTs to `/api/mobile/pair/redeem` (web derives SAS at
-- that point), then "confirmed" when the desktop user clicks Yes on
-- the SAS modal and the `/api/mobile/pair/_confirm` webhook fires.
--
-- TTL: rows older than 1h are eligible for cleanup. We don't ship a
-- cron sweep in S12 — the row is harmless until pruned and the cap
-- is enforced on insert (3 active per workspace).
--
-- `mobile_paired_devices` — long-lived row per paired device. Keyed
-- by `device_pubkey` (the mobile's locally-generated keypair public
-- half). `revoked_at` flips when the desktop user clicks Revoke.
-- `push_subscription` is a JSONB blob conforming to the W3C
-- PushSubscription serialisation; null until the device subscribes
-- (S12.5 will gate sends behind it).

CREATE TABLE mobile_pairing_challenges (
    challenge_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    pairing_code      VARCHAR(8) NOT NULL,
    -- nullable until the mobile redeems and supplies them
    device_pubkey     TEXT,
    display_name      TEXT,
    sas_digits        VARCHAR(6),
    sas_emitted_at    TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at        TIMESTAMPTZ NOT NULL,
    confirmed_at      TIMESTAMPTZ,
    rejected_at       TIMESTAMPTZ,
    paired_device_id  UUID
);

-- One active code per workspace+code pair. Two workspaces minting the
-- same Crockford string by random collision is fine (probability is
-- ~1 in 28^8 ≈ 3.8e11) — we don't enforce global uniqueness.
CREATE UNIQUE INDEX idx_mobile_pairing_workspace_code
    ON mobile_pairing_challenges (workspace_id, pairing_code)
    WHERE confirmed_at IS NULL AND rejected_at IS NULL;

CREATE INDEX idx_mobile_pairing_workspace_created
    ON mobile_pairing_challenges (workspace_id, created_at DESC);

CREATE INDEX idx_mobile_pairing_expires_at
    ON mobile_pairing_challenges (expires_at)
    WHERE confirmed_at IS NULL AND rejected_at IS NULL;

CREATE TABLE mobile_paired_devices (
    device_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    device_pubkey      TEXT NOT NULL,
    display_name       TEXT NOT NULL,
    paired_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at         TIMESTAMPTZ,
    push_subscription  JSONB
);

-- A given pubkey can only have ONE active pairing per workspace. After
-- revoke, a new pairing is allowed (pubkey reuse is fine).
CREATE UNIQUE INDEX idx_mobile_paired_devices_active
    ON mobile_paired_devices (workspace_id, device_pubkey)
    WHERE revoked_at IS NULL;

CREATE INDEX idx_mobile_paired_devices_workspace
    ON mobile_paired_devices (workspace_id, paired_at DESC);

ALTER TABLE mobile_pairing_challenges
    ADD CONSTRAINT fk_mobile_pairing_challenges_paired_device
    FOREIGN KEY (paired_device_id) REFERENCES mobile_paired_devices(device_id) ON DELETE SET NULL;
