import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const validationId = process.argv[2];
  if (!validationId) { console.error("Usage: ... <validationId>"); process.exit(1); }

  const { db, alerts, remediationSessions } = await import("../lib/db");
  const { like, desc, eq } = await import("drizzle-orm");

  const rows = await db
    .select({ id: alerts.id, title: alerts.title, createdAt: alerts.createdAt })
    .from(alerts)
    .where(like(alerts.title, `%[${validationId}-%]%`))
    .orderBy(desc(alerts.createdAt));

  console.log(`Alerts matching [${validationId}-*]: ${rows.length}\n`);
  console.log(`alert     created                 remediation`);
  console.log(`────────  ──────────────────────  ─────────────────────────────────────────────────────`);
  for (const a of rows) {
    const [r] = await db
      .select({
        id: remediationSessions.id,
        status: remediationSessions.status,
        attempt: remediationSessions.attempt,
        prUrl: remediationSessions.prUrl,
        mergeStrategy: remediationSessions.mergeStrategy,
        error: remediationSessions.error,
      })
      .from(remediationSessions)
      .where(eq(remediationSessions.alertId, a.id))
      .limit(1);
    const summary = r
      ? `${r.status.padEnd(14)} attempt=${r.attempt}  strategy=${r.mergeStrategy ?? "-"}  pr=${r.prUrl ? r.prUrl.slice(-20) : "-"}${r.error ? "  err=" + r.error.slice(0, 40) : ""}`
      : "NONE (not dispatched yet)";
    console.log(`${a.id.slice(0, 8)}  ${a.createdAt.toISOString()}  ${summary}`);
  }

  const complete = rows.filter(async (a) => {
    const [r] = await db.select({ status: remediationSessions.status }).from(remediationSessions).where(eq(remediationSessions.alertId, a.id)).limit(1);
    return r && ["proposing", "completed", "merged", "failed"].includes(r.status);
  });
  console.log(`\nTotal: ${rows.length}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
