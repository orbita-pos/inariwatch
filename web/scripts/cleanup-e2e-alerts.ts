import { config } from "dotenv";
import path from "path";
config({ path: path.join(__dirname, "..", ".env.local") });

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { and, eq, sql as sqlFn } from "drizzle-orm";
import * as schema from "../lib/db/schema";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });

async function main() {
  const rows = await db
    .select({ id: schema.alerts.id, createdAt: schema.alerts.createdAt })
    .from(schema.alerts)
    .where(sqlFn`correlation_data->>'e2eTest' = 'true'`);

  console.log(`Found ${rows.length} e2e test alerts — deleting`);
  for (const r of rows) {
    await db.delete(schema.alerts).where(eq(schema.alerts.id, r.id));
    console.log(`  deleted ${r.id} (${r.createdAt})`);
  }
}
main().catch(console.error);
