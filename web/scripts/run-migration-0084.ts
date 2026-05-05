/**
 * One-off migration runner for 0084_project_integrations_installation_id.sql.
 *
 * Adds project_integrations.installation_id (BIGINT, nullable) + partial index.
 * Phase 1 of the PAT → GitHub App OAuth migration: backward-compat link from
 * a per-project github integration row to its github_app_installations entry.
 *
 * Idempotent (ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS).
 *
 * Bypasses drizzle-kit migrate — same per-script pattern used since 0040.
 *
 * Usage: cd web && npx tsx scripts/run-migration-0084.ts
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

  console.log("Adding project_integrations.installation_id (if missing) ...");
  await sql`
    ALTER TABLE project_integrations
      ADD COLUMN IF NOT EXISTS installation_id BIGINT
  `;

  console.log("Creating partial index project_integrations_installation_idx (if missing) ...");
  await sql`
    CREATE INDEX IF NOT EXISTS project_integrations_installation_idx
      ON project_integrations(installation_id)
      WHERE installation_id IS NOT NULL
  `;

  console.log("Setting column comment ...");
  await sql`
    COMMENT ON COLUMN project_integrations.installation_id IS
      'When set, authenticate against GitHub via App installation token (mint via getInstallationToken). When NULL, fall back to PAT in configEncrypted.token. Migration 0084.'
  `;

  const rows = await sql`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'project_integrations' AND column_name = 'installation_id'
  `;
  if (rows.length !== 1) {
    console.error("Expected exactly 1 column row, got:", rows);
    process.exit(1);
  }
  console.log(`\n✓ project_integrations.installation_id:`);
  console.log(`  type: ${rows[0].data_type}`);
  console.log(`  nullable: ${rows[0].is_nullable}`);

  const counts = await sql`
    SELECT
      COUNT(*) FILTER (WHERE installation_id IS NOT NULL) AS app_rows,
      COUNT(*) FILTER (WHERE service = 'github')         AS github_rows
    FROM project_integrations
  `;
  console.log(`\ngithub integration rows total: ${counts[0].github_rows}`);
  console.log(`backed by App installation:    ${counts[0].app_rows}`);

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
