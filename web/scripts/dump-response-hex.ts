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
    .select({ response: schema.aiUsageLogs.response })
    .from(schema.aiUsageLogs)
    .where(eq(schema.aiUsageLogs.remediationSessionId, sessionId))
    .orderBy(schema.aiUsageLogs.createdAt);

  for (const [i, c] of calls.entries()) {
    const r = c.response ?? "";
    if (!r.includes("apply_patch")) continue;
    console.log(`\n===== Call ${i + 1} (${r.length} chars) =====`);
    console.log(r);
    // Hex dump of first 500 bytes to spot unicode weirdness
    const hex = Buffer.from(r, "utf8").toString("hex");
    console.log(`\n--- hex (first 500 bytes) ---`);
    const chunks = hex.slice(0, 1000).match(/.{1,32}/g) ?? [];
    console.log(chunks.join("\n"));
  }
}
main().catch(console.error);
