import { config } from "dotenv";
import path from "path";
config({ path: path.join(__dirname, "../.env.local") });
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  const r = await sql`DELETE FROM alerts WHERE id = '3401a016-31ef-4883-baad-a4f778819959' RETURNING id, title`;
  console.log("Deleted:", r);
  const seeds = await sql`SELECT COUNT(*)::int AS n FROM alerts WHERE correlation_data->>'e2eTest' = 'true'`;
  console.log("Remaining e2e test alerts:", seeds);
}
main().catch((e) => { console.error(e); process.exit(1); });
