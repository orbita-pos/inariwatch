/**
 * One-off migration runner for 0062 + 0063.
 *
 *   0062 — cost_impact_runs (Gate 14)
 *   0063 — rollout_runs (Progressive Rollout, Week 12)
 *
 * Idempotent. Usage: cd web && npx tsx scripts/run-migration-0062-0063.ts
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

  for (const file of ["0062_cost_impact.sql", "0063_rollout_runs.sql"]) {
    const path = resolvePath(process.cwd(), "lib/db/migrations", file);
    const src = readFileSync(path, "utf-8");
    const statements = splitSqlStatements(src);
    console.log(`\n→ ${file}  (${statements.length} statements)`);
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i].trim();
      if (!stmt) continue;
      const preview = stmt.replace(/\s+/g, " ").slice(0, 70);
      console.log(`  [${i + 1}/${statements.length}] ${preview} ...`);
      await sql(stmt);
    }
  }

  console.log("\nVerifying tables exist ...");
  const rows = (await sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('cost_impact_runs', 'rollout_runs')
    ORDER BY tablename
  `) as Array<{ tablename: string }>;
  for (const r of rows) console.log(`  ✓ ${r.tablename}`);
  if (rows.length !== 2) {
    console.error(`Expected 2 tables, got ${rows.length}`);
    process.exit(1);
  }
  console.log("\nMigrations 0062 + 0063 applied successfully.");
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
