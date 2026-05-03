/**
 * One-off migration runner for 0078_workspace_local_voice.sql.
 *
 * Adds organizations.local_voice_enabled (BOOLEAN NOT NULL DEFAULT FALSE).
 * v0.3 S5 — workspace flag for routing voice.tts.* (Piper) to user-sidecar
 * (Inari Live). Default off → byte-identical to pre-S5 behavior.
 *
 * Idempotent (ADD COLUMN IF NOT EXISTS), safe to re-run.
 *
 * Bypasses drizzle-kit migrate because the on-disk journal is out of sync
 * with the prod DB (see project_v0_3_docker_fix.md and the per-script
 * pattern in scripts/run-migration-0040.ts ... 0077.ts).
 *
 * Usage: cd web && npx tsx scripts/run-migration-0078.ts
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

  console.log("Adding organizations.local_voice_enabled (if missing) ...");
  await sql`
    ALTER TABLE organizations
      ADD COLUMN IF NOT EXISTS local_voice_enabled BOOLEAN NOT NULL DEFAULT FALSE
  `;

  console.log("Adding column comment ...");
  await sql`
    COMMENT ON COLUMN organizations.local_voice_enabled IS
      'v0.3 S5 — when true, voice.tts.* dispatches route to Inari Live (Piper) instead of cloud OpenAI tts-1. Default false. Sidecar offline / timeout falls back to cloud transparently per ai-router rule fallback.'
  `;

  // Verify
  const rows = await sql`
    SELECT column_name, data_type, column_default, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'organizations' AND column_name = 'local_voice_enabled'
  `;
  if (rows.length !== 1) {
    console.error("Expected exactly 1 column row, got:", rows);
    process.exit(1);
  }
  console.log(`\n✓ organizations.local_voice_enabled:`);
  console.log(`  type: ${rows[0].data_type}`);
  console.log(`  default: ${rows[0].column_default}`);
  console.log(`  nullable: ${rows[0].is_nullable}`);

  // Sanity: count of rows that have it set to true (should be 0 for default rollout)
  const counts = await sql`
    SELECT
      COUNT(*) FILTER (WHERE local_voice_enabled) AS opted_in,
      COUNT(*) AS total
    FROM organizations
  `;
  console.log(`\nWorkspaces with local_voice_enabled=true: ${counts[0].opted_in} / ${counts[0].total} total`);

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
