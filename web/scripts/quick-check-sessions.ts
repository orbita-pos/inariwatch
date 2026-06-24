import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { db } = await import("../lib/db");
  const { remediationSessions } = await import("../lib/db");
  const { gte, desc } = await import("drizzle-orm");
  const since = new Date(Date.now() - 15 * 60 * 1000);
  const rows = await db
    .select({
      id: remediationSessions.id,
      status: remediationSessions.status,
      alertId: remediationSessions.alertId,
      createdAt: remediationSessions.createdAt,
      error: remediationSessions.error,
      repo: remediationSessions.repo,
      attempt: remediationSessions.attempt,
    })
    .from(remediationSessions)
    .where(gte(remediationSessions.createdAt, since))
    .orderBy(desc(remediationSessions.createdAt));
  console.log(`Sessions in last 15 min: ${rows.length}`);
  for (const r of rows) {
    console.log(
      `  ${r.id.slice(0, 8)} ${(r.status ?? "").padEnd(14)} attempt=${r.attempt} repo=${(r.repo ?? "—").padEnd(25)} ${(r.error ?? "").slice(0, 60)}`,
    );
  }
  process.exit(0);
}
main();
