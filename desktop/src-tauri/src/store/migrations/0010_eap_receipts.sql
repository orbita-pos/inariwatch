-- Sesión 27 — local mirror of EAP attestation receipts.
--
-- The cloud `eap_receipts` table (web migration 0070) is the canonical
-- audit trail for cryptographic receipts; this desktop-side mirror
-- exists so the dock's `DockDiff` chip can render the receipt details
-- without an HTTP round-trip every render.
--
-- Each row links a `remediation_sessions.id` to the EAP server's
-- content-addressed `receipt_id` (the Merkle root). The columns marked
-- "render-only" are the bits the chip's popover surfaces — prompt
-- hash, system prompt, tools called, files read, model, signature,
-- timestamp. Heavy fields (full prompt body, tool args) live in JSON
-- blobs so we don't grow the column count when the EAP wire format
-- evolves; the popover decodes them client-side.
--
-- `recording_id` is the bridge to /v2/replay: it lets the dock POST
-- the receipt against the recording the EAP server hashed when the
-- chain was attested. NULL means "no substrate recording attached" —
-- the replay button surfaces a CTA in that case.
--
-- Foreign key on `remediation_session_id` cascades on session delete
-- so we never have orphan receipts in the desktop store. The receipt
-- row itself is content-addressed (PK = Merkle root), so a re-attest
-- of the same chain is idempotent (`INSERT OR IGNORE`).

CREATE TABLE IF NOT EXISTS eap_receipts (
    receipt_id              TEXT    PRIMARY KEY,
    remediation_session_id  TEXT    NOT NULL,
    merkle_root             TEXT    NOT NULL,
    signature               TEXT,
    signed                  INTEGER NOT NULL DEFAULT 0,

    prompt_hash             TEXT,
    system_prompt           TEXT,
    tools_called            TEXT    NOT NULL DEFAULT '[]',
    files_read              TEXT    NOT NULL DEFAULT '[]',
    model                   TEXT,

    recording_id            TEXT,

    attestor                TEXT    NOT NULL DEFAULT 'inariwatch',
    created_at              INTEGER NOT NULL,

    FOREIGN KEY (remediation_session_id)
        REFERENCES remediation_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS eap_receipts_session_idx
    ON eap_receipts (remediation_session_id);

CREATE INDEX IF NOT EXISTS eap_receipts_created_idx
    ON eap_receipts (created_at DESC);
