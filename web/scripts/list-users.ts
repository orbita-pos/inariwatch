import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { neon } = await import("@neondatabase/serverless");
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL missing in .env.local");
    process.exit(1);
  }
  const sql = neon(url);
  const rows = (await sql`
    SELECT id, email, name, password_hash IS NOT NULL AS has_password, created_at
    FROM users
    ORDER BY created_at
  `) as Array<{
    id: string;
    email: string;
    name: string | null;
    has_password: boolean;
    created_at: Date;
  }>;

  for (const u of rows) {
    const created = new Date(u.created_at).toISOString().slice(0, 19);
    console.log(
      `${u.email}  has_password=${u.has_password}  name=${u.name ?? "(null)"}  id=${u.id.slice(0, 8)}  created=${created}`
    );
  }
  console.log(`\n${rows.length} users total`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
