import { config } from "dotenv";
config({ path: ".env.local" });
async function main() {
  const { db } = await import("../lib/db");
  const { alerts, remediationSessions } = await import("../lib/db");
  const { sql, gte, desc, eq } = await import("drizzle-orm");
  const since = new Date(Date.now() - 15 * 60 * 1000);
  const rows = await db
    .select({ id: alerts.id, title: alerts.title, body: alerts.body, createdAt: alerts.createdAt })
    .from(alerts)
    .where(sql`${alerts.createdAt} >= ${since} AND ${alerts.repo} = 'orbita-pos/inariwatch-demo-store' AND ${alerts.body} LIKE '%__inari_bugs_fixtures__%'`)
    .orderBy(desc(alerts.createdAt))
    .limit(10);
  for (const r of rows) {
    const [sess] = await db.select({ id: remediationSessions.id, status: remediationSessions.status }).from(remediationSessions).where(eq(remediationSessions.alertId, r.id)).limit(1);
    const bugMatch = r.body?.match(/__inari_bugs_fixtures__\/(bug-\d+-[a-z-]+)/);
    console.log(`${r.id}  ${(bugMatch?.[1] ?? "?").padEnd(30)}  session=${sess ? sess.status : "NONE"}`);
  }
  process.exit(0);
}
main();
