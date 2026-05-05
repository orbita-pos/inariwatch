/**
 * One-off migration runner for 0085_github_app_installations_nullable_org.sql.
 *
 * Drops NOT NULL on github_app_installations.organization_id so personal-
 * mode installs (no workspace) can persist without a synthetic org row.
 *
 * Idempotent (DROP NOT NULL is a no-op when already nullable).
 *
 * Usage: cd web && npx tsx scripts/run-migration-0085.ts
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

  console.log("Dropping NOT NULL on github_app_installations.organization_id (idempotent) ...");
  await sql`
    ALTER TABLE github_app_installations
      ALTER COLUMN organization_id DROP NOT NULL
  `;

  await sql`
    COMMENT ON COLUMN github_app_installations.organization_id IS
      'NULL = personal install (no workspace). Set = install belongs to that org. Migration 0085.'
  `;

  const rows = await sql`
    SELECT is_nullable
    FROM information_schema.columns
    WHERE table_name = 'github_app_installations' AND column_name = 'organization_id'
  `;
  console.log(`\n✓ github_app_installations.organization_id nullable: ${rows[0]?.is_nullable}`);

  const counts = await sql`
    SELECT
      COUNT(*) FILTER (WHERE organization_id IS NULL) AS personal_installs,
      COUNT(*) FILTER (WHERE organization_id IS NOT NULL) AS org_installs,
      COUNT(*) AS total
    FROM github_app_installations
  `;
  console.log(`Personal installs: ${counts[0].personal_installs}`);
  console.log(`Org installs:      ${counts[0].org_installs}`);
  console.log(`Total:             ${counts[0].total}`);

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
