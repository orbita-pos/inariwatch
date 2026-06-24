import { config } from "dotenv";
config({ path: ".env.local" });

/**
 * Enable Postgres extensions required by the InariWatch schema. Run once
 * against a fresh Neon (or any Postgres) database before `drizzle-kit push`.
 *
 *   npx tsx scripts/enable-pg-extensions.ts
 */
async function main() {
  const { neon } = await import("@neondatabase/serverless");
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL missing in .env.local");
    process.exit(1);
  }
  const host = url.match(/@([^/]+)/)?.[1] ?? "unknown";
  console.log(`Connecting to ${host} ...`);
  const sql = neon(url);

  const extensions = [
    "vector",   // pgvector — code intelligence embeddings, fix-replay similarity
    "pg_trgm",  // trigram similarity — fuzzy search / community fix matching
  ];

  for (const ext of extensions) {
    console.log(`Enabling ${ext} ...`);
    await sql(`CREATE EXTENSION IF NOT EXISTS "${ext}"`);
  }

  const rows = (await sql`
    SELECT extname FROM pg_extension ORDER BY extname
  `) as Array<{ extname: string }>;
  console.log(`\nInstalled extensions:`);
  for (const r of rows) console.log(`  ✓ ${r.extname}`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
