-- VAR Q3 Phase 2 — link remediations to EAP receipts.
--
-- When a remediation completes successfully and a substrate_recording
-- exists for the triggering alert/session, the eap-attestation service
-- POSTs the event stream to the EAP server, which Merkle-roots + signs
-- + stores the receipt and returns its ID. We persist that ID here so
-- the alert detail page can link to /attestation/<id> for public audit.
--
-- The column is nullable — remediations that ran before Phase 2 (or ran
-- without a substrate recording available, or during EAP downtime) stay
-- unattested. The UI renders the "View attestation" link only when the
-- column is populated.
--
-- Reverse:
--   DROP INDEX IF EXISTS remediation_sessions_eap_receipt_idx;
--   ALTER TABLE remediation_sessions DROP COLUMN IF EXISTS eap_receipt_id;

ALTER TABLE remediation_sessions
  ADD COLUMN IF NOT EXISTS eap_receipt_id text;

-- Partial index — the overwhelming majority of rows will have NULL
-- until Phase 2 has been live for a while, so keep the index skinny.
CREATE INDEX IF NOT EXISTS remediation_sessions_eap_receipt_idx
  ON remediation_sessions (eap_receipt_id)
  WHERE eap_receipt_id IS NOT NULL;

COMMENT ON COLUMN remediation_sessions.eap_receipt_id IS
  'Content-addressed EAP receipt ID (64-char hex Merkle root). Populated by the eap-attestation service after a successful remediation when a substrate_recording is available. Links the remediation to its public audit URL at /attestation/<id>. NULL for remediations that predate Phase 2 or ran without a recording.';
