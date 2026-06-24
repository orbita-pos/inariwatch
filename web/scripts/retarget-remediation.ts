import { config } from "dotenv";
config({ path: ".env.local" });

/**
 * Local-only: repoint a completed remediation_sessions row to a real
 * GitHub repo + branch so Preview Fix Tier 1 can clone + build for E2E
 * testing. Use when the original target was a seed/fixture that doesn't
 * exist on GitHub.
 *
 * Usage: npx tsx scripts/retarget-remediation.ts <alertId> <owner/repo> <branch> <commitSha>
 */
async function main() {
  const [alertId, repo, branch, sha] = process.argv.slice(2);
  if (!alertId || !repo || !branch || !sha) {
    console.error("Usage: npx tsx scripts/retarget-remediation.ts <alertId> <owner/repo> <branch> <sha>");
    process.exit(1);
  }

  const { db, remediationSessions } = await import("../lib/db");
  const { eq, desc } = await import("drizzle-orm");

  const [rem] = await db
    .select()
    .from(remediationSessions)
    .where(eq(remediationSessions.alertId, alertId))
    .orderBy(desc(remediationSessions.createdAt))
    .limit(1);
  if (!rem) { console.log("No remediation for alert " + alertId); process.exit(1); }

  console.log(`Before: ${rem.repo}@${rem.branch}  sha=${rem.mergedCommitSha?.slice(0,7) ?? "(none)"}`);

  await db
    .update(remediationSessions)
    .set({ repo, branch, mergedCommitSha: sha })
    .where(eq(remediationSessions.id, rem.id));

  const [updated] = await db
    .select({ repo: remediationSessions.repo, branch: remediationSessions.branch, mergedCommitSha: remediationSessions.mergedCommitSha })
    .from(remediationSessions)
    .where(eq(remediationSessions.id, rem.id));
  console.log(`After:  ${updated.repo}@${updated.branch}  sha=${updated.mergedCommitSha?.slice(0,7)}`);

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
