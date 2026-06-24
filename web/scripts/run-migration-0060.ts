/**
 * One-off migration runner for 0060_behavioral_drift.sql.
 *
 * Creates two tables:
 *   - session_endpoint_metrics (raw per-(recording, endpoint) baseline samples)
 *   - behavioral_drift_runs    (one row per alert+remediation+fix sha)
 *
 * Idempotent (CREATE TABLE / INDEX IF NOT EXISTS), safe to re-run.
 *
 * Usage: cd web && npx tsx scripts/run-migration-0060.ts
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
    "lib/db/migrations/0060_behavioral_drift.sql",
  );
  const migrationSql = readFileSync(migrationPath, "utf-8");

  // Split on statement-terminating semicolons that live OUTSIDE of
  // single-quoted strings and `--` line comments. We manually lex so
  // COMMENT bodies with inline punctuation survive.
  const statements = splitSqlStatements(migrationSql);
  console.log(`Migration has ${statements.length} statement(s).`);

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i].trim();
    if (stmt.length === 0) continue;
    const preview = stmt.replace(/\s+/g, " ").slice(0, 80);
    console.log(`[${i + 1}/${statements.length}] ${preview} ...`);
    await sql(stmt);
  }

  console.log("");
  console.log("Verifying tables exist ...");
  const check = (await sql`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('session_endpoint_metrics', 'behavioral_drift_runs')
    ORDER BY tablename
  `) as Array<{ tablename: string }>;
  for (const row of check) {
    console.log(`  ✓ ${row.tablename}`);
  }
  if (check.length !== 2) {
    console.error(`Expected 2 tables, got ${check.length}`);
    process.exit(1);
  }

  console.log("");
  console.log("Migration 0060 applied successfully.");
}

/**
 * Split a .sql file into statements. Tracks:
 *   - `--` line comments (to EOL)
 *   - single-quoted strings (with '' escape)
 *   - dollar-quoted strings (rare but legal)
 * Semicolons inside any of those do NOT split.
 */
function splitSqlStatements(src: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    // Line comment
    if (c === "-" && next === "-") {
      buf += c;
      i++;
      while (i < src.length && src[i] !== "\n") {
        buf += src[i];
        i++;
      }
      continue;
    }
    // Single-quoted string
    if (c === "'") {
      buf += c;
      i++;
      while (i < src.length) {
        if (src[i] === "'" && src[i + 1] === "'") {
          buf += "''";
          i += 2;
          continue;
        }
        buf += src[i];
        if (src[i] === "'") {
          i++;
          break;
        }
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
