#!/usr/bin/env node
/**
 * Applies migration 0093_inari_hash.sql directly via pg.
 *
 * Run from web/:
 *   node scripts/apply-0093-migration.mjs
 *
 * Reads DATABASE_URL from env or .env.local.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// Load .env.local if present
try {
  const { config } = await import("dotenv");
  config({ path: ".env.local" });
} catch {}

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "lib", "db", "migrations");

const ALREADY_EXISTS_CODES = new Set(["42710", "42P07", "42701", "42P06"]);

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

  const file = "0093_inari_hash.sql";
  const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
  console.log(`── ${file} ──`);

  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log("  ✓ applied\n");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.code && ALREADY_EXISTS_CODES.has(err.code)) {
      console.log(`  ⊘ skip — already exists (${err.code})\n`);
    } else {
      console.error(`  ✗ FAILED ${err.code}: ${err.message}`);
      process.exit(2);
    }
  }

  // Verify
  console.log("── verification ──");
  const { rows: cols } = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='alerts' AND column_name='inari_hash'"
  );
  console.log(`  ${cols.length ? "✓" : "✗"} alerts.inari_hash`);

  const { rows: idx } = await client.query(
    "SELECT indexname FROM pg_indexes WHERE tablename='alerts' AND indexname='alerts_inari_hash_idx'"
  );
  console.log(`  ${idx.length ? "✓" : "✗"} alerts_inari_hash_idx`);

  const { rows: backfill } = await client.query(
    "SELECT COUNT(*) AS total, COUNT(inari_hash) AS hashed FROM alerts"
  );
  const { total, hashed } = backfill[0];
  console.log(`  ✓ backfill: ${hashed}/${total} alerts have inari_hash`);

  await client.end();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  client.end().catch(() => {});
  process.exit(1);
});
