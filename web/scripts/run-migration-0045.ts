/**
 * One-off migration runner for 0045_alert_hourly_counts.sql.
 * Adds the alert_hourly_counts table for anomaly detection rollups.
 *
 * Idempotent (CREATE TABLE / INDEX IF NOT EXISTS), safe to re-run.
 *
 * Usage: cd web && npx tsx scripts/run-migration-0045.ts
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

  console.log("Creating alert_hourly_counts table ...");
  await sql`
    CREATE TABLE IF NOT EXISTS "alert_hourly_counts" (
      "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
      "hour" timestamp NOT NULL,
      "alert_count" integer NOT NULL DEFAULT 0,
      "updated_at" timestamp DEFAULT now() NOT NULL,
      PRIMARY KEY ("project_id", "hour")
    )
  `;

  console.log("Creating index idx_alert_hourly_counts_hour ...");
  await sql`
    CREATE INDEX IF NOT EXISTS "idx_alert_hourly_counts_hour"
      ON "alert_hourly_counts" ("hour" DESC)
  `;

  console.log("Verifying table exists ...");
  const result = await sql`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'alert_hourly_counts'
    ORDER BY ordinal_position
  `;

  if (result.length === 0) {
    console.error("alert_hourly_counts table not found after migration");
    process.exit(1);
  }
  console.log(`Columns: ${result.map((r) => `${r.column_name}:${r.data_type}`).join(", ")}`);

  console.log("Migration 0045 applied successfully.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
