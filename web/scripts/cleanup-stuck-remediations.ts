/**
 * Cleanup stuck remediation sessions.
 *
 * The concurrency check in lib/ai/concurrency.ts treats sessions in
 * status `analyzing`, `reading_code`, `generating_fix`, `pushing`, or
 * `awaiting_ci` as active.  When a runRemediation() call is interrupted
 * (process killed, terminal closed, worker timeout that doesn't update
 * the DB), the session can stay in one of those statuses forever,
 * blocking the per-project concurrency cap (3) for new remediations.
 *
 * This script marks any session in an active status whose `updatedAt`
 * is older than 30 minutes as `failed`, freeing up the slot.
 *
 * Usage:
 *     cd web && npx tsx scripts/cleanup-stuck-remediations.ts
 *
 * Defaults to dry-run.  Pass --apply to actually update.
 *
 *     cd web && npx tsx scripts/cleanup-stuck-remediations.ts --apply
 */

import { config } from "dotenv";
import path from "path";
config({ path: path.join(__dirname, "../.env.local") });

// Default: 30min.  Override with --minutes=N for quicker cleanup
// during PR #8 testing where stuck sessions may only be ~10-15 min old.
const minutesArg = process.argv.find((a) => a.startsWith("--minutes="));
const STUCK_AFTER_MINUTES = minutesArg
  ? parseInt(minutesArg.split("=")[1], 10)
  : 30;
const APPLY = process.argv.includes("--apply");

async function main() {
  const { db } = await import("../lib/db");
  const { remediationSessions } = await import("../lib/db");
  const { sql, and, lt, inArray, eq } = await import("drizzle-orm");

  const stuckSince = new Date(Date.now() - STUCK_AFTER_MINUTES * 60 * 1000);
  const activeStatuses = ["analyzing", "reading_code", "generating_fix", "pushing", "awaiting_ci"];

  const stuck = await db
    .select({
      id: remediationSessions.id,
      status: remediationSessions.status,
      projectId: remediationSessions.projectId,
      createdAt: remediationSessions.createdAt,
      updatedAt: remediationSessions.updatedAt,
    })
    .from(remediationSessions)
    .where(
      and(
        inArray(remediationSessions.status, activeStatuses),
        lt(remediationSessions.updatedAt, stuckSince),
      ),
    );

  if (stuck.length === 0) {
    console.log(`No sessions stuck for >${STUCK_AFTER_MINUTES}min in active states.`);
    process.exit(0);
  }

  console.log(`Found ${stuck.length} stuck session(s):`);
  for (const s of stuck) {
    const ageMin = Math.round((Date.now() - new Date(s.updatedAt).getTime()) / 60000);
    console.log(`  ${s.id.slice(0, 8)}  status=${s.status}  project=${s.projectId.slice(0, 8)}  age=${ageMin}min`);
  }

  if (!APPLY) {
    console.log(`\nDry run. Pass --apply to mark these as failed.`);
    process.exit(0);
  }

  const ids = stuck.map((s) => s.id);
  await db
    .update(remediationSessions)
    .set({ status: "failed", error: `Auto-failed by cleanup-stuck-remediations.ts (>${STUCK_AFTER_MINUTES}min in active state)` })
    .where(inArray(remediationSessions.id, ids));

  console.log(`\nMarked ${ids.length} session(s) as failed.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
