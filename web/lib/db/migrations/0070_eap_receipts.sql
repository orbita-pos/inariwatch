-- Fase 11 — Substrate + EAP as First-class Gates
--
-- Local mirror of EAP attestation receipts.
--
-- The EAP server at eap.inariwatch.com is the cryptographic source of truth
-- (Merkle root + Ed25519 signature + full proof chain). It stores every
-- receipt in its own SQLite DB and signs each one with the attestor key.
--
-- This table mirrors the *metadata* of each receipt so that:
--
--   a) widgets / dashboards can answer "how many verified fixes this week?"
--      without round-tripping to EAP for every query;
--   b) `GET /api/eap/verify/:receiptId` can serve the receipt metadata
--      without an EAP RTT on every hit (the full chain still proxies through
--      the existing /api/attestation/:id endpoint when the client asks for
--      it);
--   c) we retain a tamper-evident audit trail locally even during EAP
--      downtime.
--
-- Security notes:
--   - This table NEVER stores private keys. Only the Merkle root (public)
--     and the Ed25519 signature (public).
--   - `receipt_id` IS the Merkle root (content-addressed), but we keep
--     `merkle_root` as a separate column for clarity and forward-compat in
--     case the EAP ID format ever changes (e.g. HMAC prefix).
--   - `signature` is nullable — the EAP server returns unsigned receipts
--     when deployed without an attestor keypair. These receipts still carry
--     a valid Merkle root but cannot be independently verified.
--   - `verified` is the result of a *local* signature check (against the
--     cached attestor pubkey). The EAP server /chain/:id endpoint remains
--     the authoritative verifier.
--
-- The column `remediation_sessions.eap_receipt_id` (from migration 0064)
-- keeps working as-is: it's the fast "does this remediation have an
-- attestation?" lookup. This new table is for listings and cross-alert
-- reporting that don't want to walk remediation_sessions.
--
-- Rollback:
--   DROP TABLE IF EXISTS eap_receipts;

CREATE TABLE IF NOT EXISTS eap_receipts (
  -- Content-addressed ID: 64-char hex Merkle root returned by EAP.
  receipt_id             text PRIMARY KEY,

  -- What this receipt attests to. alert_id is required; remediation is
  -- optional so we can extend later to alert-only attestations.
  alert_id               uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  remediation_session_id uuid REFERENCES remediation_sessions(id) ON DELETE SET NULL,

  -- Source recording — the EAP server hashed THIS event stream.
  recording_id           text NOT NULL,

  -- Public cryptographic material. merkle_root == receipt_id today but
  -- kept separate for forward-compat. signature is NULL when EAP was
  -- deployed without an attestor keypair (unsigned receipt).
  merkle_root            text NOT NULL,
  signature              text,
  signed                 boolean NOT NULL DEFAULT false,

  event_count            integer NOT NULL DEFAULT 0,
  attestor               text NOT NULL DEFAULT 'inariwatch',

  -- Local verification cache. Separate from the EAP server's verification
  -- report. NULL = never locally verified; true/false = result of last
  -- `verifyReceiptLocally` pass.
  verified               boolean,
  verified_at            timestamptz,

  created_at             timestamptz NOT NULL DEFAULT now()
);

-- Listing/reporting indexes. receipt_id is already PK.
CREATE INDEX IF NOT EXISTS eap_receipts_alert_idx
  ON eap_receipts (alert_id);

CREATE INDEX IF NOT EXISTS eap_receipts_remediation_idx
  ON eap_receipts (remediation_session_id)
  WHERE remediation_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS eap_receipts_created_idx
  ON eap_receipts (created_at DESC);

COMMENT ON TABLE eap_receipts IS
  'Fase 11 — local mirror of EAP server receipts. The EAP server at eap.inariwatch.com remains the cryptographic source of truth. This table exists so widgets, dashboards, and the /api/eap/verify/:receiptId endpoint can answer metadata questions without round-tripping on every call. Content-addressed: receipt_id = Merkle root.';

COMMENT ON COLUMN eap_receipts.signature IS
  'Hex-encoded Ed25519 signature over the Merkle root. NULL when the EAP server was deployed without an attestor keypair; the receipt is still valid (Merkle root is tamper-evident) but cannot be cryptographically proven by a third party.';

COMMENT ON COLUMN eap_receipts.verified IS
  'Result of the last LOCAL signature verification pass (against cached attestor pubkey). Separate from the EAP server verification report served at /api/attestation/:id. NULL = not yet locally verified.';
