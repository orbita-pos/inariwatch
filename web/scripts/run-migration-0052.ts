import { readFileSync } from "fs";
import { neon } from "@neondatabase/serverless";

async function main() {
  const env = readFileSync(".env.local", "utf-8");
  const m = env.match(/^DATABASE_URL="?([^"\n]+)"?$/m);
  if (!m) { console.error("DATABASE_URL not found"); process.exit(1); }
  const sql = neon(m[1]);
  console.log("Adding web_vitals jsonb column ...");
  await sql`
    ALTER TABLE replay_sessions
      ADD COLUMN IF NOT EXISTS web_vitals jsonb NOT NULL DEFAULT '{}'::jsonb
  `;
  const cols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='replay_sessions' AND column_name='web_vitals'
  `;
  console.log(`Column present: ${cols.length === 1}`);
  console.log("Migration 0052 applied.");
}

main().catch((e) => { console.error(e); process.exit(1); });
