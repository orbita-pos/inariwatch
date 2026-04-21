import { config } from "dotenv";
config({ path: ".env.local" });
async function main() {
  const { db } = await import("../lib/db");
  const { alerts } = await import("../lib/db");
  const { sql, gte, desc } = await import("drizzle-orm");
  const since = new Date(Date.now() - 20 * 60 * 1000);
  const rows = await db
    .select({ id: alerts.id, title: alerts.title, repo: alerts.repo })
    .from(alerts)
    .where(sql`${alerts.createdAt} >= ${since} AND ${alerts.severity} = 'critical' AND ${alerts.repo} = 'orbita-pos/inariwatch-demo-store'`)
    .orderBy(desc(alerts.createdAt))
    .limit(5);
  for (const r of rows) console.log(`${r.id}  ${(r.title ?? "").slice(0, 60)}`);
  process.exit(0);
}
main();
