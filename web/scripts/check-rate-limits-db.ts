import { config } from "dotenv";
config({ path: ".env.local" });

/**
 * Inspect + optionally clear the DB fallback rate-limit table.
 * Kamal-proxy environments where the @upstash/ratelimit client times out
 * silently fall through to this table — the Upstash scanner wouldn't see
 * the block then.
 *
 *   npx tsx scripts/check-rate-limits-db.ts           # list everything
 *   npx tsx scripts/check-rate-limits-db.ts --clear   # delete everything
 *   npx tsx scripts/check-rate-limits-db.ts --clear register-ip   # one ns
 */
async function main() {
  const { neon } = await import("@neondatabase/serverless");
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL missing in .env.local");
    process.exit(1);
  }
  const sql = neon(url);

  const args = process.argv.slice(2);
  const doClear = args.includes("--clear");
  const nsFilter = args.find((a) => !a.startsWith("--"));

  console.log("=== rate_limits table ===");
  const rows = (await sql`
    SELECT key, count, window_start FROM rate_limits ORDER BY window_start DESC LIMIT 50
  `) as Array<{ key: string; count: number; window_start: Date }>;

  if (rows.length === 0) {
    console.log("  (empty)");
  } else {
    for (const r of rows) {
      const age = Math.round((Date.now() - new Date(r.window_start).getTime()) / 1000);
      console.log(`  ${r.key}  count=${r.count}  started=${age}s ago`);
    }
  }

  if (doClear) {
    let deleted: Array<{ count: number }>;
    if (nsFilter) {
      const pattern = `${nsFilter}:%`;
      deleted = (await sql`
        DELETE FROM rate_limits WHERE key LIKE ${pattern} RETURNING 1 AS count
      `) as Array<{ count: number }>;
      console.log(`\n=> deleted ${deleted.length} rows matching ${nsFilter}:*`);
    } else {
      deleted = (await sql`
        DELETE FROM rate_limits RETURNING 1 AS count
      `) as Array<{ count: number }>;
      console.log(`\n=> deleted ${deleted.length} rows (all)`);
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
