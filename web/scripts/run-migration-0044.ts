/**
 * One-off migration runner for 0044_hosting_providers.sql.
 * Adds netlify, cloudflare-pages, render, railway, fly to the integration enum.
 *
 * Idempotent (ADD VALUE IF NOT EXISTS), safe to re-run.
 *
 * Usage: cd web && npx tsx scripts/run-migration-0044.ts
 */

import { readFileSync } from "fs";
import { neon } from "@neondatabase/serverless";

const NEW_VALUES = ["netlify", "cloudflare-pages", "render", "railway", "fly"] as const;

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

  // Postgres requires each ALTER TYPE ADD VALUE in its own statement — they
  // can't run inside a transaction. The neon() HTTP driver runs each tagged
  // template as a separate round-trip, which is exactly what we need.
  // DDL can't be parameterized, so each value is hardcoded.
  console.log("Adding 'netlify' to integration enum ...");
  await sql`ALTER TYPE "integration" ADD VALUE IF NOT EXISTS 'netlify'`;
  console.log("Adding 'cloudflare-pages' to integration enum ...");
  await sql`ALTER TYPE "integration" ADD VALUE IF NOT EXISTS 'cloudflare-pages'`;
  console.log("Adding 'render' to integration enum ...");
  await sql`ALTER TYPE "integration" ADD VALUE IF NOT EXISTS 'render'`;
  console.log("Adding 'railway' to integration enum ...");
  await sql`ALTER TYPE "integration" ADD VALUE IF NOT EXISTS 'railway'`;
  console.log("Adding 'fly' to integration enum ...");
  await sql`ALTER TYPE "integration" ADD VALUE IF NOT EXISTS 'fly'`;

  console.log("Verifying enum values ...");
  const result = await sql`
    SELECT enumlabel
    FROM pg_enum
    WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'integration')
    ORDER BY enumsortorder
  `;

  const labels = result.map((r) => r.enumlabel as string);
  console.log("Current integration enum values:", labels.join(", "));

  const missing = NEW_VALUES.filter((v) => !labels.includes(v));
  if (missing.length > 0) {
    console.error("Missing values after migration:", missing.join(", "));
    process.exit(1);
  }

  console.log("Migration 0044 applied successfully.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
