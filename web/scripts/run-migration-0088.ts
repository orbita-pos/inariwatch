/**
 * One-off migration runner for 0088_mobile_pairing.sql.
 *
 * Creates two tables for the S12 mobile chat-agent PWA pairing flow:
 * - mobile_pairing_challenges (one row per active pairing attempt; TTL 1h)
 * - mobile_paired_devices (long-lived row per paired device, with revoke support)
 *
 * Originally numbered 0084 in the S12 worktree (CLAUDE.md showed 0083 as
 * the latest applied at the time), but slot 0084 was already taken by
 * 0084_project_integrations_installation_id.sql from a parallel branch
 * (github-app installation work). Renamed to 0088 (next free slot) at
 * the collapse merge to resolve the duplicate-prefix conflict.
 *
 * Idempotent (IF NOT EXISTS on tables/indexes; DO block for FK).
 *
 * Usage: cd web && npx tsx scripts/run-migration-0088.ts
 */

import { readFileSync } from "fs";
import { neon } from "@neondatabase/serverless";

async function main() {
  const env = readFileSync(".env.local", "utf-8");
  const match = env.match(/^DATABASE_URL="?([^"\n]+)"?$/m);
  if (!match) {
    console.error("DATABASE_URL not found in .env.local");
    process.exit(1);
  }
  const dbUrl = match[1];
  const host = dbUrl.match(/@([^/]+)/)?.[1] ?? "unknown";
  console.log(`Connecting to ${host} ...`);

  const sql = neon(dbUrl);

  console.log("Creating mobile_pairing_challenges table (idempotent) ...");
  await sql`
    CREATE TABLE IF NOT EXISTS mobile_pairing_challenges (
      challenge_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      pairing_code      VARCHAR(8) NOT NULL,
      device_pubkey     TEXT,
      display_name      TEXT,
      sas_digits        VARCHAR(6),
      sas_emitted_at    TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at        TIMESTAMPTZ NOT NULL,
      confirmed_at      TIMESTAMPTZ,
      rejected_at       TIMESTAMPTZ,
      paired_device_id  UUID
    )
  `;

  console.log("Creating mobile_paired_devices table (idempotent) ...");
  await sql`
    CREATE TABLE IF NOT EXISTS mobile_paired_devices (
      device_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      device_pubkey      TEXT NOT NULL,
      display_name       TEXT NOT NULL,
      paired_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at         TIMESTAMPTZ,
      push_subscription  JSONB
    )
  `;

  console.log("Creating indexes (idempotent) ...");
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_pairing_workspace_code
      ON mobile_pairing_challenges (workspace_id, pairing_code)
      WHERE confirmed_at IS NULL AND rejected_at IS NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_mobile_pairing_workspace_created
      ON mobile_pairing_challenges (workspace_id, created_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_mobile_pairing_expires_at
      ON mobile_pairing_challenges (expires_at)
      WHERE confirmed_at IS NULL AND rejected_at IS NULL
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_paired_devices_active
      ON mobile_paired_devices (workspace_id, device_pubkey)
      WHERE revoked_at IS NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_mobile_paired_devices_workspace
      ON mobile_paired_devices (workspace_id, paired_at DESC)
  `;

  console.log("Adding FK constraint (idempotent via DO block) ...");
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_mobile_pairing_challenges_paired_device'
      ) THEN
        ALTER TABLE mobile_pairing_challenges
          ADD CONSTRAINT fk_mobile_pairing_challenges_paired_device
          FOREIGN KEY (paired_device_id)
          REFERENCES mobile_paired_devices(device_id)
          ON DELETE SET NULL;
      END IF;
    END $$;
  `;

  console.log("\nVerifying tables ...");
  const rows = await sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_name IN ('mobile_pairing_challenges', 'mobile_paired_devices')
    ORDER BY table_name
  `;
  for (const r of rows) {
    console.log(`  ✓ ${r.table_name}`);
  }
  if (rows.length !== 2) {
    console.error(`\n✗ Expected 2 tables, got ${rows.length}`);
    process.exit(1);
  }

  const counts = await sql`
    SELECT
      (SELECT COUNT(*) FROM mobile_pairing_challenges) AS challenges,
      (SELECT COUNT(*) FROM mobile_paired_devices)     AS devices
  `;
  console.log(`\nmobile_pairing_challenges rows: ${counts[0].challenges}`);
  console.log(`mobile_paired_devices rows:     ${counts[0].devices}`);

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
