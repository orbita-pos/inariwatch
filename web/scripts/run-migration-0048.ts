/**
 * One-off migration runner for 0048_project_allowed_origins.sql.
 * Adds projects.allowed_origins text[] NOT NULL DEFAULT '{}'.
 *
 * Backward-compatible: existing projects get an empty array which the
 * validation helper treats as "allow any Origin" (no breakage).
 *
 * Idempotent (ADD COLUMN IF NOT EXISTS), safe to re-run.
 *
 * Usage: cd web && npx tsx scripts/run-migration-0048.ts
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

  console.log("Adding projects.allowed_origins column ...");
  await sql`
    ALTER TABLE "projects"
      ADD COLUMN IF NOT EXISTS "allowed_origins" text[] NOT NULL DEFAULT '{}'
  `;

  console.log("Verifying column ...");
  const rows = await sql`
    SELECT column_name, data_type, column_default
    FROM information_schema.columns
    WHERE table_name = 'projects' AND column_name = 'allowed_origins'
  `;
  if (rows.length === 0) {
    console.error("Column not found after migration.");
    process.exit(1);
  }
  console.log(`Column: ${rows[0].column_name} (${rows[0].data_type}), default=${rows[0].column_default}`);

  console.log("Migration 0048 applied successfully.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
