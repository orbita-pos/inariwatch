/**
 * One-off migration runner for 0065_preview_fix.sql.
 *
 * Creates:
 *   - preview_predictions  (AI render cache, one row per alert+commit)
 *   - preview_sessions     (orchestration row per alert+remediation)
 *
 * Adds columns to remediation_sessions:
 *   - preview_session_id  (FK → preview_sessions)
 *   - preview_enabled_at  (first preview creation timestamp)
 *
 * Idempotent: every DDL uses `IF NOT EXISTS` so re-running is a no-op.
 *
 * Usage: cd web && npx tsx scripts/run-migration-0065.ts
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
    "lib/db/migrations/0065_preview_fix.sql",
  );
  const src = readFileSync(migrationPath, "utf-8");
  const statements = splitSqlStatements(src);
  console.log(`Migration has ${statements.length} statement(s).`);

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i].trim();
    if (!stmt) continue;
    const preview = stmt.replace(/\s+/g, " ").slice(0, 80);
    console.log(`[${i + 1}/${statements.length}] ${preview} ...`);
    await sql(stmt);
  }

  console.log("\nVerifying tables + columns ...");

  const tables = (await sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('preview_sessions', 'preview_predictions')
    ORDER BY table_name
  `) as Array<{ table_name: string }>;
  if (tables.length !== 2) {
    console.error(`Expected 2 preview tables, found ${tables.length}`);
    process.exit(1);
  }
  for (const t of tables) console.log(`  ✓ ${t.table_name}`);

  const cols = (await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'remediation_sessions'
      AND column_name IN ('preview_session_id', 'preview_enabled_at')
    ORDER BY column_name
  `) as Array<{ column_name: string }>;
  if (cols.length !== 2) {
    console.error(`Expected 2 new columns on remediation_sessions, found ${cols.length}`);
    process.exit(1);
  }
  for (const c of cols) console.log(`  ✓ remediation_sessions.${c.column_name}`);

  const indices = (await sql`
    SELECT indexname
    FROM pg_indexes
    WHERE tablename IN ('preview_sessions', 'preview_predictions', 'remediation_sessions')
      AND indexname LIKE 'preview_%' OR indexname = 'remediation_sessions_preview_idx'
    ORDER BY indexname
  `) as Array<{ indexname: string }>;
  console.log(`\n  indices: ${indices.map((i) => i.indexname).join(", ")}`);

  console.log("\nMigration 0065 applied successfully.");
}

function splitSqlStatements(src: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "-" && next === "-") {
      buf += c;
      i++;
      while (i < src.length && src[i] !== "\n") { buf += src[i]; i++; }
      continue;
    }
    if (c === "'") {
      buf += c;
      i++;
      while (i < src.length) {
        if (src[i] === "'" && src[i + 1] === "'") { buf += "''"; i += 2; continue; }
        buf += src[i];
        if (src[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    if (c === ";") {
      out.push(buf);
      buf = "";
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  if (buf.trim().length > 0) out.push(buf);
  return out;
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
