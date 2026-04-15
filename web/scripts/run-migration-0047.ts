/**
 * One-off migration runner for 0047_replay_urls_index.sql.
 * Adds the GIN index on replay_sessions.urls_visited and a trigram index
 * on replay_sessions.browser to speed up the /replays list search.
 *
 * Idempotent (CREATE INDEX / EXTENSION IF NOT EXISTS), safe to re-run.
 *
 * Usage: cd web && npx tsx scripts/run-migration-0047.ts
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

  console.log("Creating pg_trgm extension (if missing) ...");
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;

  console.log("Creating GIN index idx_replay_sessions_urls ...");
  await sql`
    CREATE INDEX IF NOT EXISTS "idx_replay_sessions_urls"
      ON "replay_sessions" USING GIN ("urls_visited")
  `;

  console.log("Creating trigram index idx_replay_sessions_browser_trgm ...");
  await sql`
    CREATE INDEX IF NOT EXISTS "idx_replay_sessions_browser_trgm"
      ON "replay_sessions" USING GIN ("browser" gin_trgm_ops) WHERE "browser" IS NOT NULL
  `;

  console.log("Verifying indexes ...");
  const rows = await sql`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'replay_sessions' AND indexname IN (
      'idx_replay_sessions_urls',
      'idx_replay_sessions_browser_trgm'
    )
    ORDER BY indexname
  `;
  console.log(`Indexes present: ${rows.map((r) => r.indexname).join(", ")}`);

  console.log("Migration 0047 applied successfully.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
