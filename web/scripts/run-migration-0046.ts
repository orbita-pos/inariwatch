/**
 * One-off migration runner for 0046_replay_sessions.sql.
 * Adds the replay_sessions table (Replay V2 metadata + R2 storage refs)
 * and a backward-compatible FK on substrate_recordings.
 *
 * Idempotent (CREATE TABLE / INDEX / COLUMN IF NOT EXISTS), safe to re-run.
 *
 * Usage: cd web && npx tsx scripts/run-migration-0046.ts
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

  console.log("Creating replay_sessions table ...");
  await sql`
    CREATE TABLE IF NOT EXISTS "replay_sessions" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "session_id" text NOT NULL UNIQUE,
      "organization_id" uuid REFERENCES "organizations"("id") ON DELETE CASCADE,
      "project_id" uuid REFERENCES "projects"("id") ON DELETE CASCADE,
      "alert_id" uuid REFERENCES "alerts"("id") ON DELETE SET NULL,
      "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
      "started_at" timestamptz NOT NULL,
      "ended_at" timestamptz,
      "duration_ms" integer,
      "r2_prefix" text NOT NULL,
      "block_count" integer NOT NULL DEFAULT 0,
      "total_bytes" bigint NOT NULL DEFAULT 0,
      "click_selectors" text[] NOT NULL DEFAULT '{}',
      "urls_visited" text[] NOT NULL DEFAULT '{}',
      "error_fingerprints" text[] NOT NULL DEFAULT '{}',
      "frustration_score" integer NOT NULL DEFAULT 0,
      "browser" text,
      "os" text,
      "country" text,
      "viewport" jsonb,
      "ai_summary" text,
      "ai_chapters" jsonb,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    )
  `;

  console.log("Creating index idx_replay_sessions_org_started ...");
  await sql`
    CREATE INDEX IF NOT EXISTS "idx_replay_sessions_org_started"
      ON "replay_sessions" ("organization_id", "started_at" DESC)
  `;

  console.log("Creating index idx_replay_sessions_project_started ...");
  await sql`
    CREATE INDEX IF NOT EXISTS "idx_replay_sessions_project_started"
      ON "replay_sessions" ("project_id", "started_at" DESC)
  `;

  console.log("Creating index idx_replay_sessions_alert ...");
  await sql`
    CREATE INDEX IF NOT EXISTS "idx_replay_sessions_alert"
      ON "replay_sessions" ("alert_id") WHERE "alert_id" IS NOT NULL
  `;

  console.log("Creating GIN index idx_replay_sessions_clicks ...");
  await sql`
    CREATE INDEX IF NOT EXISTS "idx_replay_sessions_clicks"
      ON "replay_sessions" USING GIN ("click_selectors")
  `;

  console.log("Creating GIN index idx_replay_sessions_errors ...");
  await sql`
    CREATE INDEX IF NOT EXISTS "idx_replay_sessions_errors"
      ON "replay_sessions" USING GIN ("error_fingerprints")
  `;

  console.log("Adding replay_session_id FK column to substrate_recordings ...");
  await sql`
    ALTER TABLE "substrate_recordings"
      ADD COLUMN IF NOT EXISTS "replay_session_id" uuid REFERENCES "replay_sessions"("id") ON DELETE SET NULL
  `;

  console.log("Creating index idx_substrate_recordings_replay_session ...");
  await sql`
    CREATE INDEX IF NOT EXISTS "idx_substrate_recordings_replay_session"
      ON "substrate_recordings" ("replay_session_id") WHERE "replay_session_id" IS NOT NULL
  `;

  console.log("Verifying replay_sessions exists ...");
  const cols = await sql`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'replay_sessions'
    ORDER BY ordinal_position
  `;
  if (cols.length === 0) {
    console.error("replay_sessions table not found after migration");
    process.exit(1);
  }
  console.log(`replay_sessions: ${cols.length} columns`);

  console.log("Verifying substrate_recordings.replay_session_id exists ...");
  const fkCol = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'substrate_recordings' AND column_name = 'replay_session_id'
  `;
  if (fkCol.length === 0) {
    console.error("substrate_recordings.replay_session_id not added");
    process.exit(1);
  }
  console.log("FK column present.");

  console.log("Migration 0046 applied successfully.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
