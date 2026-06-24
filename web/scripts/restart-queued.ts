/**
 * Restart queued remediation sessions — re-runs runRemediation() on
 * each session that's currently in `queued` state from the given
 * window. Bounded concurrency so we don't re-saturate the limits.
 *
 * Usage: cd web && npx tsx scripts/restart-queued.ts [--concurrency=2] [--apply]
 */
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const args = process.argv.slice(2);
  const concurrency = parseInt(args.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? "2", 10);
  const apply = args.includes("--apply");
  const minutes = parseInt(args.find((a) => a.startsWith("--minutes="))?.split("=")[1] ?? "120", 10);

  const { db } = await import("../lib/db");
  const { remediationSessions } = await import("../lib/db");
  const { gte, eq, and } = await import("drizzle-orm");
  const { runRemediation } = await import("../lib/ai/remediate");

  const since = new Date(Date.now() - minutes * 60 * 1000);
  const queued = await db
    .select({ id: remediationSessions.id, alertId: remediationSessions.alertId, attempt: remediationSessions.attempt })
    .from(remediationSessions)
    .where(and(
      gte(remediationSessions.createdAt, since),
      eq(remediationSessions.status, "queued"),
    ));

  console.log(`Queued sessions to restart: ${queued.length}`);
  for (const q of queued) console.log(`  ${q.id.slice(0, 8)} (attempt ${q.attempt})`);

  if (!apply) { console.log(`\nDry-run. Re-run with --apply to execute.`); process.exit(0); }

  // Flip them back to "analyzing" so runRemediation picks up normally
  for (const q of queued) {
    await db.update(remediationSessions)
      .set({ status: "analyzing" })
      .where(eq(remediationSessions.id, q.id));
  }

  const started = Date.now();
  for (let i = 0; i < queued.length; i += concurrency) {
    const batch = queued.slice(i, i + concurrency);
    console.log(`\n[${i}/${queued.length}] running batch of ${batch.length}`);
    await Promise.all(batch.map(async (q) => {
      try {
        await runRemediation(q.id, () => {});
      } catch (err) {
        console.error(`  ${q.id.slice(0, 8)} threw: ${err instanceof Error ? err.message : String(err)}`);
      }
      const [final] = await db.select({ status: remediationSessions.status, error: remediationSessions.error })
        .from(remediationSessions).where(eq(remediationSessions.id, q.id)).limit(1);
      console.log(`  ${q.id.slice(0, 8)} final=${final?.status} ${(final?.error ?? "").slice(0, 80)}`);
    }));
  }

  console.log(`\nElapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
