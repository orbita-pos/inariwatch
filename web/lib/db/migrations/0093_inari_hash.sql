-- Inari Hash — content-addressed portable identifiers.
--
-- Every alert gets a stable `inari:alert:<16-hex>` hash derived from
-- immutable fields. Including `id` in the payload guarantees uniqueness
-- even when historical alerts share the same fingerprint (same error
-- recurred after the 24h dedup window expired and was resolved).
--
-- Hash algorithm: sha256(JSON.stringify(sortedPayload))[0..16]
-- Sorted keys: fingerprint < id < projectId (alphabetical)
-- JSON format: {"fingerprint":"...","id":"uuid","projectId":"uuid"}
--
-- This matches exactly what createAlertIfNew() produces in TypeScript
-- so resolver lookups work for both historical and new alerts.

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS inari_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS alerts_inari_hash_idx
  ON alerts(inari_hash)
  WHERE inari_hash IS NOT NULL;

-- Backfill existing rows using the same JSON canonicalization as TS.
-- pgcrypto sha256() is always available on Neon. md5 fallback for local PG.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    UPDATE alerts
    SET inari_hash = 'inari:alert:' || LEFT(
      encode(
        sha256(
          ('{"fingerprint":"' ||
            COALESCE(fingerprint, title) ||
            '","id":"' || id::text ||
            '","projectId":"' || project_id::text ||
          '"}')::bytea
        ),
        'hex'
      ),
      16
    )
    WHERE inari_hash IS NULL;
  ELSE
    -- md5 fallback for local PG without pgcrypto
    UPDATE alerts
    SET inari_hash = 'inari:alert:' || LEFT(
      md5('{"fingerprint":"' ||
        COALESCE(fingerprint, title) ||
        '","id":"' || id::text ||
        '","projectId":"' || project_id::text ||
      '"}'),
      16
    )
    WHERE inari_hash IS NULL;
  END IF;
END;
$$;
