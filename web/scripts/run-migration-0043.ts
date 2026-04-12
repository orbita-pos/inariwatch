/**
 * One-off migration runner for 0043_alert_skipped_reason.sql.
 * Adds the ai_skipped_reason column to the alerts table.
 *
 * Idempotent (ADD COLUMN IF NOT EXISTS), safe to re-run.
 *
 * Usage: cd web && npx tsx scripts/run-migration-0043.ts
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

  console.log("Applying ALTER TABLE alerts ADD COLUMN IF NOT EXISTS ai_skipped_reason text ...");
  await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS ai_skipped_reason text`;

  console.log("Verifying column exists ...");
  const cols = await sql`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'alerts' AND column_name = 'ai_skipped_reason'
  `;

  if (cols.length === 0) {
    console.error("Column was not created.");
    process.exit(1);
  }

  console.log("Column verified:", cols[0]);
  console.log("Migration 0043 applied successfully.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
