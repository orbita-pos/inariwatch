/**
 * Snapshot of all sessions from the last N min, with grouping by status
 * and a list of queued ones that can be restarted.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const minutes = parseInt(process.argv[2] ?? "60", 10);
  const { db } = await import("../lib/db");
  const { remediationSessions, alerts } = await import("../lib/db");
  const { gte, desc, eq } = await import("drizzle-orm");

  const since = new Date(Date.now() - minutes * 60 * 1000);
  const rows = await db
    .select({
      id: remediationSessions.id,
      alertId: remediationSessions.alertId,
      status: remediationSessions.status,
      attempt: remediationSessions.attempt,
      repo: remediationSessions.repo,
      branch: remediationSessions.branch,
      confidenceScore: remediationSessions.confidenceScore,
      prUrl: remediationSessions.prUrl,
      error: remediationSessions.error,
      createdAt: remediationSessions.createdAt,
    })
    .from(remediationSessions)
    .where(gte(remediationSessions.createdAt, since))
    .orderBy(desc(remediationSessions.createdAt));

  console.log(`\n=== Sessions last ${minutes} min: ${rows.length} ===\n`);

  const byStatus = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.status ?? "null";
    if (!byStatus.has(key)) byStatus.set(key, []);
    byStatus.get(key)!.push(r);
  }
  for (const [status, list] of byStatus) {
    console.log(`  ${status.padEnd(22)} ${list.length}`);
  }

  console.log(`\nDetail (one line each):`);
  for (const r of rows) {
    const alertTitleRows = await db
      .select({ title: alerts.title })
      .from(alerts)
      .where(eq(alerts.id, r.alertId))
      .limit(1);
    const title = alertTitleRows[0]?.title ?? "(no alert)";
    const conf = r.confidenceScore != null ? `${r.confidenceScore}%` : "—";
    console.log(
      `  ${r.id.slice(0, 8)} ${(r.status ?? "").padEnd(14)} a=${r.attempt} conf=${conf.padEnd(4)} repo=${(r.repo ?? "—").padEnd(25)} ${title.slice(0, 55)}`
    );
    if (r.error) console.log(`    err: ${r.error.slice(0, 120)}`);
  }

  const queued = rows.filter((r) => r.status === "queued");
  if (queued.length > 0) {
    console.log(`\nQueued sessions (can be restarted):`);
    for (const q of queued) console.log(`  ${q.id}`);
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
