/**
 * Re-runs `analyzeReplay(sessionId, { force: true })` against existing
 * replay sessions in the active org, so Phase E (rage + dead clicks) data
 * gets populated for sessions that were captured BEFORE the analyzer
 * learned about frustration signals.
 *
 * Usage:
 *   cd web && npx tsx scripts/reanalyze-replay-sessions.ts            # all
 *   cd web && npx tsx scripts/reanalyze-replay-sessions.ts s_abc123   # one
 *   cd web && npx tsx scripts/reanalyze-replay-sessions.ts --org <orgId>
 *
 * Re-analysis costs one Haiku call per session (~$0.001) and rewrites
 * aiSummary + aiChapters + rageClicks + deadClicks + frustrationScore.
 */

// Load .env.local synchronously BEFORE the @/lib/db import runs (which
// reads DATABASE_URL at module-load). Dynamic-import everything below.
import { readFileSync } from "fs";

const envText = readFileSync(".env.local", "utf-8");
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"\n]*?)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

async function main() {
  const { db } = await import("@/lib/db");
  const { replaySessions } = await import("@/lib/db/schema");
  const { eq, desc } = await import("drizzle-orm");
  const { analyzeReplay } = await import("@/lib/jobs/replay-analyze");

  const args = process.argv.slice(2);
  const orgArgIdx = args.indexOf("--org");
  const orgId = orgArgIdx >= 0 ? args[orgArgIdx + 1] : undefined;
  // Treat the first non-flag arg as a sessionId.
  const sessionIdArg = args.find((a) => !a.startsWith("--") && a !== orgId);

  let sessions: { sessionId: string; startedAt: Date }[];

  if (sessionIdArg) {
    const rows = await db
      .select({ sessionId: replaySessions.sessionId, startedAt: replaySessions.startedAt })
      .from(replaySessions)
      .where(eq(replaySessions.sessionId, sessionIdArg))
      .limit(1);
    sessions = rows;
  } else {
    const rows = await db
      .select({ sessionId: replaySessions.sessionId, startedAt: replaySessions.startedAt })
      .from(replaySessions)
      .where(orgId ? eq(replaySessions.organizationId, orgId) : undefined)
      .orderBy(desc(replaySessions.startedAt))
      .limit(50);
    sessions = rows;
  }

  if (sessions.length === 0) {
    console.log("No sessions matched.");
    return;
  }

  console.log(`Re-analyzing ${sessions.length} session(s)...\n`);

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (const s of sessions) {
    const stamp = s.startedAt.toISOString().slice(0, 19).replace("T", " ");
    process.stdout.write(`  ${s.sessionId.padEnd(24)} ${stamp}  ... `);
    try {
      const result = await analyzeReplay(s.sessionId, { force: true });
      if (result.skipped) {
        console.log(`skipped (${result.skipped})`);
        skipped++;
      } else {
        const rage = result.rageClicksCount ?? 0;
        const dead = result.deadClicksCount ?? 0;
        const score = result.frustrationScore ?? 0;
        console.log(
          `ok  chapters=${result.chaptersCount ?? 0} chains=${result.chainsCount ?? 0} ` +
            `rage=${rage} dead=${dead} score=${score}`,
        );
        ok++;
      }
    } catch (err) {
      console.log(`FAILED — ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  console.log(`\nDone. ok=${ok} skipped=${skipped} failed=${failed}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
