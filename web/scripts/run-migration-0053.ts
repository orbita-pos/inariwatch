import { readFileSync } from "fs";
import { neon } from "@neondatabase/serverless";

async function main() {
  const env = readFileSync(".env.local", "utf-8");
  const m = env.match(/^DATABASE_URL="?([^"\n]+)"?$/m);
  if (!m) { console.error("DATABASE_URL not found"); process.exit(1); }
  const sql = neon(m[1]);
  console.log("Adding alerts.replay_session_id column ...");
  await sql`
    ALTER TABLE alerts
      ADD COLUMN IF NOT EXISTS replay_session_id uuid
        REFERENCES replay_sessions(id) ON DELETE SET NULL
  `;
  console.log("Creating partial index ...");
  await sql`
    CREATE INDEX IF NOT EXISTS alerts_replay_session_idx
      ON alerts (replay_session_id)
      WHERE replay_session_id IS NOT NULL
  `;
  const cols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='alerts' AND column_name='replay_session_id'
  `;
  console.log(`Column present: ${cols.length === 1}`);
  console.log("Migration 0053 applied.");
}

main().catch((e) => { console.error(e); process.exit(1); });
