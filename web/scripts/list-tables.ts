import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { neon } = await import("@neondatabase/serverless");
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL missing in .env.local");
    process.exit(1);
  }
  const host = url.match(/@([^/]+)/)?.[1] ?? "unknown";
  console.log(`host: ${host}`);
  const sql = neon(url);

  const rows = (await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY table_name
  `) as Array<{ table_name: string }>;

  console.log(`=== ${rows.length} tables ===`);
  for (const r of rows) console.log(`  ${r.table_name}`);

  // Spot-check critical tables the register/login path touches
  for (const t of ["users", "rate_limits", "accounts", "sessions"]) {
    const exists = rows.some((r) => r.table_name === t);
    console.log(`  check ${t}: ${exists ? "OK" : "MISSING"}`);
  }

  if (rows.some((r) => r.table_name === "users")) {
    const [u] = (await sql`SELECT COUNT(*)::int AS n FROM users`) as Array<{ n: number }>;
    console.log(`\nusers row count: ${u.n}`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
