#!/usr/bin/env node
/**
 * Applies migration 0094_local_embeddings.sql directly via pg.
 *
 * Resizes all vector columns 1024 → 768 (nomic-embed-code output).
 * Drops + recreates HNSW indexes. Nullifies existing embeddings — a
 * full re-index is required after running this script.
 *
 * Run from web/:
 *   node scripts/apply-0094-migration.mjs
 *
 * Reads DATABASE_URL from env or .env.local.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

try {
  const { config } = await import("dotenv");
  config({ path: ".env.local" });
} catch {}

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "lib", "db", "migrations");

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL not set. Load env first (sops decrypt or .env.local).");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  await client.connect();
  console.log("Connected.\n");

  const file = "0094_local_embeddings.sql";
  const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
  console.log(`── ${file} ──`);
  console.log("  ⚠  This nullifies all existing embeddings and resizes vector columns 1024 → 768.");
  console.log("     Re-index all connected repos after this completes.\n");

  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log("  ✓ applied\n");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`  ✗ FAILED ${err.code}: ${err.message}`);
    process.exit(2);
  }

  // Verify column dimensions
  console.log("── verification ──");
  const { rows: cols } = await client.query(`
    SELECT relname AS table_name, atttypmod AS dims
    FROM pg_attribute
    JOIN pg_class ON pg_class.oid = pg_attribute.attrelid
    JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
    WHERE nspname = 'public'
      AND attname IN ('embedding', 'fix_embedding')
      AND attnum > 0
      AND NOT attisdropped
      AND relname IN ('code_chunks', 'remediation_sessions', 'pattern_memory')
    ORDER BY relname
  `);
  for (const r of cols) {
    // pgvector stores atttypmod = n directly (unlike varchar which adds 4)
    const dims = r.dims > 0 ? r.dims : "?";
    const ok = dims === 768;
    console.log(`  ${ok ? "✓" : "✗"} ${r.table_name}.embedding = vector(${dims})`);
  }

  // Verify HNSW indexes exist
  const { rows: idxs } = await client.query(`
    SELECT indexname FROM pg_indexes
    WHERE tablename IN ('code_chunks', 'remediation_sessions', 'pattern_memory')
      AND indexname IN (
        'idx_code_chunks_embedding',
        'idx_remediation_fix_embedding',
        'idx_pattern_memory_embedding'
      )
    ORDER BY indexname
  `);
  const indexNames = new Set(idxs.map((r) => r.indexname));
  for (const name of [
    "idx_code_chunks_embedding",
    "idx_remediation_fix_embedding",
    "idx_pattern_memory_embedding",
  ]) {
    console.log(`  ${indexNames.has(name) ? "✓" : "✗"} ${name}`);
  }

  // Null count (all should be 0 after migration)
  const { rows: nulls } = await client.query(`
    SELECT
      (SELECT COUNT(*) FROM code_chunks       WHERE embedding IS NOT NULL)    AS cc_has_emb,
      (SELECT COUNT(*) FROM remediation_sessions WHERE fix_embedding IS NOT NULL) AS rs_has_emb,
      (SELECT COUNT(*) FROM pattern_memory    WHERE embedding IS NOT NULL)    AS pm_has_emb
  `);
  const n = nulls[0];
  console.log(`  ${+n.cc_has_emb === 0 ? "✓" : "⚠"} code_chunks: ${n.cc_has_emb} rows with non-null embedding`);
  console.log(`  ${+n.rs_has_emb === 0 ? "✓" : "⚠"} remediation_sessions: ${n.rs_has_emb} rows with non-null fix_embedding`);
  console.log(`  ${+n.pm_has_emb === 0 ? "✓" : "⚠"} pattern_memory: ${n.pm_has_emb} rows with non-null embedding`);

  await client.end();
  console.log("\nDone. Trigger a re-index for each connected repo to regenerate 768-dim embeddings.");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  client.end().catch(() => {});
  process.exit(1);
});
