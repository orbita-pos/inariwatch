import { readFileSync } from "fs";
import { neon } from "@neondatabase/serverless";

async function main() {
  const env = readFileSync(".env.local", "utf-8");
  const m = env.match(/^DATABASE_URL="?([^"\n]+)"?$/m);
  if (!m) { console.error("DATABASE_URL not found"); process.exit(1); }
  const sql = neon(m[1]);
  console.log("Creating replay_comments table …");
  await sql`
    CREATE TABLE IF NOT EXISTS replay_comments (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id      text NOT NULL REFERENCES replay_sessions(session_id) ON DELETE CASCADE,
      user_id         uuid NOT NULL REFERENCES users(id)             ON DELETE CASCADE,
      timestamp_ms    integer NOT NULL CHECK (timestamp_ms >= 0),
      body            text NOT NULL,
      parent_id       uuid REFERENCES replay_comments(id)            ON DELETE CASCADE,
      resolved        boolean NOT NULL DEFAULT false,
      mentioned_user_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    )
  `;
  console.log("Creating session+timestamp index …");
  await sql`
    CREATE INDEX IF NOT EXISTS replay_comments_session_idx
      ON replay_comments (session_id, timestamp_ms)
  `;
  console.log("Creating mentions GIN index …");
  await sql`
    CREATE INDEX IF NOT EXISTS replay_comments_mentions_idx
      ON replay_comments USING GIN (mentioned_user_ids)
  `;
  const cols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='replay_comments' ORDER BY column_name
  `;
  console.log(`Columns: ${cols.map((r) => r.column_name).join(", ")}`);
  console.log("Migration 0055 applied.");
}

main().catch((e) => { console.error(e); process.exit(1); });
