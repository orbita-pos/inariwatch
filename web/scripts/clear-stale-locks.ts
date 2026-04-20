import { config } from "dotenv";
import path from "path";
config({ path: path.join(__dirname, "..", ".env.local") });

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { sql as sqlFn } from "drizzle-orm";
import * as schema from "../lib/db/schema";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });

async function main() {
  const repo = process.argv[2] ?? "orbita-pos/inariwatch-demo-store";
  // Release ALL locks on this repo — safe because we ARE the only
  // test harness against the demo-store.
  const res = await sql`
    DELETE FROM remediation_locks
    WHERE repo_id = ${repo}
    RETURNING session_id, file_path
  `;
  console.log(`Released ${res.length} locks on ${repo}`);
  for (const row of res) console.log(`  ${row.file_path}  (session ${(row.session_id as string)?.slice(0, 8)}…)`);
}
main().catch(console.error);
