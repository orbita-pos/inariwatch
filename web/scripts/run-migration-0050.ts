/**
 * One-off migration runner for 0050_rage_dead_clicks.sql.
 * Adds rage_clicks/dead_clicks jsonb columns + functional indexes.
 *
 * Idempotent (ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS).
 *
 * Usage: cd web && npx tsx scripts/run-migration-0050.ts
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

  console.log("Adding rage_clicks + dead_clicks columns ...");
  await sql`
    ALTER TABLE replay_sessions
      ADD COLUMN IF NOT EXISTS rage_clicks jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS dead_clicks jsonb NOT NULL DEFAULT '[]'::jsonb
  `;

  console.log("Creating rage count index ...");
  await sql`
    CREATE INDEX IF NOT EXISTS replay_sessions_rage_count_idx
      ON replay_sessions ((jsonb_array_length(rage_clicks)))
  `;

  console.log("Creating dead count index ...");
  await sql`
    CREATE INDEX IF NOT EXISTS replay_sessions_dead_count_idx
      ON replay_sessions ((jsonb_array_length(dead_clicks)))
  `;

  console.log("Verifying ...");
  const cols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'replay_sessions'
      AND column_name IN ('rage_clicks', 'dead_clicks')
    ORDER BY column_name
  `;
  console.log(`Columns present: ${cols.map((r) => r.column_name).join(", ")}`);

  console.log("Migration 0050 applied successfully.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
