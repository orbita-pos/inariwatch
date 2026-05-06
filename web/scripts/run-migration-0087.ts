/**
 * One-off migration runner for 0087_replay_sessions_personal_idx.sql.
 *
 * Adds a partial index on replay_sessions(user_id, started_at DESC)
 * WHERE organization_id IS NULL — keeps the personal-workspace list
 * query cheap.
 *
 * Idempotent (IF NOT EXISTS). CONCURRENTLY → safe on live DB.
 *
 * Usage: cd web && npx tsx scripts/run-migration-0087.ts
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

  console.log("Creating partial index replay_sessions_user_personal_idx (CONCURRENTLY, idempotent) ...");
  await sql`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS replay_sessions_user_personal_idx
      ON replay_sessions (user_id, started_at DESC)
      WHERE organization_id IS NULL
  `;

  await sql`
    COMMENT ON INDEX replay_sessions_user_personal_idx IS
      'Personal-workspace list lookup. Partial: only sessions with NULL org. Migration 0087.'
  `;

  const rows = await sql`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE tablename = 'replay_sessions'
      AND indexname = 'replay_sessions_user_personal_idx'
  `;
  if (rows.length === 0) {
    console.error("\n✗ Index not found after creation");
    process.exit(1);
  }
  console.log(`\n✓ ${rows[0].indexname}`);
  console.log(`  ${rows[0].indexdef}`);

  const counts = await sql`
    SELECT
      COUNT(*) FILTER (WHERE organization_id IS NULL) AS personal_sessions,
      COUNT(*) FILTER (WHERE organization_id IS NOT NULL) AS org_sessions,
      COUNT(*) AS total
    FROM replay_sessions
  `;
  console.log(`\nPersonal sessions: ${counts[0].personal_sessions}`);
  console.log(`Org sessions:      ${counts[0].org_sessions}`);
  console.log(`Total:             ${counts[0].total}`);

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
