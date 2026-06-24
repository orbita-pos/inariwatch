/**
 * Adds projects.replay_settings jsonb NOT NULL DEFAULT '{}'.
 *
 * Backward-compatible: empty JSON means "use hardcoded defaults"
 * (DEFAULT_REPLAY_SETTINGS in schema.ts).
 *
 * Usage: cd web && npx tsx scripts/run-migration-0049.ts
 */

import { readFileSync } from "fs";
import { neon } from "@neondatabase/serverless";

async function main() {
  const env = readFileSync(".env.local", "utf-8");
  const match = env.match(/^DATABASE_URL="?([^"\n]+)"?$/m);
  if (!match) { console.error("DATABASE_URL not found"); process.exit(1); }
  const sql = neon(match[1]);

  console.log("Adding projects.replay_settings column ...");
  await sql`
    ALTER TABLE "projects"
      ADD COLUMN IF NOT EXISTS "replay_settings" jsonb NOT NULL DEFAULT '{}'::jsonb
  `;

  const rows = await sql`
    SELECT column_name, data_type, column_default
    FROM information_schema.columns
    WHERE table_name = 'projects' AND column_name = 'replay_settings'
  `;
  if (rows.length === 0) { console.error("Column not created"); process.exit(1); }
  console.log(`Column: ${rows[0].column_name} (${rows[0].data_type}), default=${rows[0].column_default}`);
  console.log("Migration 0049 applied.");
}

main().catch((err) => { console.error(err); process.exit(1); });
