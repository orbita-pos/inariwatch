/**
 * One-off migration runner for 0067_preview_screenshot.sql.
 *
 * Adds to preview_sessions:
 *   - screenshot_url       (Vercel Blob CDN URL)
 *   - screenshot_taken_at  (capture timestamp)
 *   - screenshot_width     (px)
 *   - screenshot_height    (px)
 *   - screenshot_error     (reason if capture failed)
 *
 * All nullable + additive.
 *
 * Usage: cd web && npx tsx scripts/run-migration-0067.ts
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
    "lib/db/migrations/0067_preview_screenshot.sql",
  );
  const src = readFileSync(migrationPath, "utf-8");
  console.log(`Applying migration ...`);
  await sql(src);

  console.log("\nVerifying columns ...");
  const cols = (await sql`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'preview_sessions'
      AND column_name LIKE 'screenshot%'
    ORDER BY column_name
  `) as Array<{ column_name: string; data_type: string; is_nullable: string }>;

  if (cols.length !== 5) {
    console.error(`Expected 5 screenshot columns, found ${cols.length}`);
    process.exit(1);
  }
  for (const c of cols) {
    console.log(`  ✓ preview_sessions.${c.column_name}  ${c.data_type}  null=${c.is_nullable}`);
  }

  console.log("\nMigration 0067 applied successfully.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
