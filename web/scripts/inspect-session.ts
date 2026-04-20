import { config } from "dotenv";
import path from "path";
config({ path: path.join(__dirname, "..", ".env.local") });

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq } from "drizzle-orm";
import * as schema from "../lib/db/schema";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });

const sessionId = process.argv[2];
if (!sessionId) throw new Error("usage: inspect-session.ts <sessionId>");

async function main() {
  const [s] = await db
    .select()
    .from(schema.remediationSessions)
    .where(eq(schema.remediationSessions.id, sessionId))
    .limit(1);
  console.log(`Status: ${s?.status}  attempts: ${s?.attempt}`);
  console.log(`Error: ${s?.error ?? "(none)"}`);
  console.log(`Steps (${(s?.steps ?? []).length}):`);
  for (const step of (s?.steps as Array<{ type?: string; status?: string; message?: string }> ?? [])) {
    console.log(`  [${step.status}] ${step.type}: ${(step.message ?? "").slice(0, 200)}`);
  }
}
main().catch(console.error);
