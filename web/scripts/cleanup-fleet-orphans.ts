/**
 * Find and remove orphan replay_sessions created by a failed seed-fleet-demo run.
 * An orphan is a `demo-fleet-*` session WITHOUT a whatif_replays cache row
 * (= the seed crashed mid-iteration before writing the cache). These make
 * fleet verification runs call real substrate against the fake repo,
 * producing spurious "errored" outcomes.
 */
import { db } from "@/lib/db";
import {
  replaySessions,
  substrateRecordings,
  whatifReplays,
} from "@/lib/db/schema";
import { sql, inArray } from "drizzle-orm";

async function main() {
  const orphans = await db
    .select({ sid: replaySessions.sessionId })
    .from(replaySessions)
    .where(sql`${replaySessions.sessionId} LIKE 'demo-fleet-%'
      AND NOT EXISTS (
        SELECT 1 FROM whatif_replays WHERE session_id = ${replaySessions.sessionId}
      )`);

  if (orphans.length === 0) {
    console.log("No orphan fleet sessions. Nothing to clean up.");
    return;
  }

  const ids = orphans.map((o) => o.sid);
  console.log(`Found ${ids.length} orphan(s):`, ids);

  await db.delete(substrateRecordings).where(inArray(substrateRecordings.sessionId, ids));
  await db.delete(whatifReplays).where(inArray(whatifReplays.sessionId, ids));
  await db.delete(replaySessions).where(inArray(replaySessions.sessionId, ids));

  console.log(`Deleted ${ids.length} orphan session(s) + their recordings.`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
