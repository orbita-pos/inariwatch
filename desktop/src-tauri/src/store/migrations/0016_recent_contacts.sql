-- Inari Live Phase 5.5 completion — recent-contacts ring buffer.
--
-- Stores the WhatsApp recipients the user has recently messaged via
-- `/whatsapp`. Mirrors `recent_paths` (0015) — same shape, same
-- ON CONFLICT(jid) DO UPDATE pattern, same eviction-by-LRU.
--
-- Why a separate table from `paired_entities`: those are SAS-paired
-- recipients (cryptographically verified). This buffer is a softer
-- "people you've messaged" set populated by any successful send,
-- including raw-E.164 recipients that never go through SAS. The
-- contact picker promotes rows here to the top so follow-up sends
-- don't need a full retype.
--
-- Capped at 20 entries by the touch_recent_contact() helper in
-- `store::recent_contacts`. Eviction is by `last_used_at` ascending.

CREATE TABLE recent_contacts (
  jid           TEXT    PRIMARY KEY,
  name          TEXT    NOT NULL,
  last_used_at  INTEGER NOT NULL
);

CREATE INDEX recent_contacts_last_used_idx
  ON recent_contacts(last_used_at DESC);
