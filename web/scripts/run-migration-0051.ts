/**
 * One-off migration runner for 0051_replay_end_user.sql.
 * Adds end_user_id/email/email_hash columns + partial index.
 *
 * Idempotent. Usage: cd web && npx tsx scripts/run-migration-0051.ts
 */

import { readFileSync } from "fs";
import { neon } from "@neondatabase/serverless";

async function main() {
  const env = readFileSync(".env.local", "utf-8");
  const match = env.match(/^DATABASE_URL="?([^"\n]+)"?$/m);
  if (!match) { console.error("DATABASE_URL not found in .env.local"); process.exit(1); }
  const dbUrl = match[1];
  const host = dbUrl.match(/@([^/]+)/)?.[1] ?? "unknown";
  console.log(`Connecting to ${host} ...`);

  const sql = neon(dbUrl);

  console.log("Adding end_user columns ...");
  await sql`
    ALTER TABLE replay_sessions
      ADD COLUMN IF NOT EXISTS end_user_id         text,
      ADD COLUMN IF NOT EXISTS end_user_email      text,
      ADD COLUMN IF NOT EXISTS end_user_email_hash text
  `;

  console.log("Creating end_user partial index ...");
  await sql`
    CREATE INDEX IF NOT EXISTS replay_sessions_end_user_idx
      ON replay_sessions (project_id, end_user_id)
      WHERE end_user_id IS NOT NULL
  `;

  const cols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'replay_sessions'
      AND column_name IN ('end_user_id', 'end_user_email', 'end_user_email_hash')
    ORDER BY column_name
  `;
  console.log(`Columns present: ${cols.map((r) => r.column_name).join(", ")}`);
  console.log("Migration 0051 applied successfully.");
}

main().catch((err) => { console.error("Migration failed:", err); process.exit(1); });
