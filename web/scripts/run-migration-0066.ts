/**
 * One-off migration runner for 0066_integration_health.sql.
 *
 * Adds to project_integrations:
 *   - last_error_at       (timestamp of last auth / 401 failure)
 *   - last_error_message  (short human-readable reason)
 *
 * Both nullable + additive — no existing code paths break.
 *
 * Usage: cd web && npx tsx scripts/run-migration-0066.ts
 */

import { readFileSync } from "fs";
import { neon } from "@neondatabase/serverless";
import { resolve as resolvePath } from "node:path";

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

  const migrationPath = resolvePath(
    process.cwd(),
    "lib/db/migrations/0066_integration_health.sql",
  );
  const src = readFileSync(migrationPath, "utf-8");
  console.log(`Applying migration ...`);
  await sql(src);

  console.log("\nVerifying columns ...");
  const cols = (await sql`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'project_integrations'
      AND column_name IN ('last_error_at', 'last_error_message')
    ORDER BY column_name
  `) as Array<{ column_name: string; data_type: string; is_nullable: string }>;

  if (cols.length !== 2) {
    console.error(`Expected 2 new columns, found ${cols.length}`);
    process.exit(1);
  }
  for (const c of cols) {
    console.log(`  ✓ project_integrations.${c.column_name}  ${c.data_type}  null=${c.is_nullable}`);
  }

  console.log("\nMigration 0066 applied successfully.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
