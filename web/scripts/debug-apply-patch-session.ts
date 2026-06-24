import { config } from "dotenv";
import path from "path";
config({ path: path.join(__dirname, "..", ".env.local") });

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq } from "drizzle-orm";
import * as schema from "../lib/db/schema";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });

const sessionId = process.argv[2] ?? "c32a095a-924c-445c-b928-1a60cfe75423";

async function main() {
  const calls = await db
    .select({
      feature: schema.aiUsageLogs.feature,
      model: schema.aiUsageLogs.model,
      response: schema.aiUsageLogs.response,
    })
    .from(schema.aiUsageLogs)
    .where(eq(schema.aiUsageLogs.remediationSessionId, sessionId))
    .orderBy(schema.aiUsageLogs.createdAt);

  console.log(`Session ${sessionId}: ${calls.length} AI calls`);
  for (const [i, c] of calls.entries()) {
    const resp = c.response ?? "";
    if (resp.includes("apply_patch") || resp.includes("Begin Patch")) {
      console.log(`\n===== Call ${i + 1} [${c.model}] ${c.feature} =====`);
      console.log(resp.slice(0, 4000));
      console.log(`\n(response length: ${resp.length})`);
    }
  }
}
main().catch(console.error);
