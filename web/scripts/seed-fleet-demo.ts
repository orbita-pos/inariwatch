/**
 * Seed sibling sessions for a Fleet Verification end-to-end test.
 *
 * Takes an existing alert (--alert-id <uuid>) and creates N additional
 * (replay_session + substrate_recording + alert) triples that share
 * the alert's fingerprint + projectId. Each sibling also gets a
 * precomputed whatif_replays row pointing at the remediation's fix
 * commit sha, so when the worker's fleet job runs it hits cache
 * instantly instead of attempting real clones against a fake repo.
 *
 * Outcome distribution: 9/10 matched, 1/10 would_not_prevent. That
 * produces a 90% gauge — right at the auto-merge threshold — so the
 * UI can demo both "passes gate" and "non-matching session drill-down"
 * in the same card.
 *
 * Usage:
 *   cd web && npx tsx --env-file=.env.local scripts/seed-fleet-demo.ts \
 *     --alert-id <alertUuid> --count 10
 *
 * Rerun-safety: uses randomUUID + timestamp, so each invocation
 * creates a fresh set (previous siblings stay as history).
 */

import { db } from "@/lib/db";
import {
  alerts,
  projects,
  remediationSessions,
  replaySessions,
  substrateRecordings,
  whatifReplays,
} from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";

// ── CLI parsing ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function argOf(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const ALERT_ID = argOf("--alert-id");
const COUNT = Number(argOf("--count") ?? 10);

if (!ALERT_ID) {
  console.error("Usage: npx tsx scripts/seed-fleet-demo.ts --alert-id <uuid> [--count 10]");
  process.exit(1);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // Resolve the seed alert + its latest merged remediation + its org.
  const [seed] = await db
    .select({
      alertId: alerts.id,
      projectId: alerts.projectId,
      fingerprint: alerts.fingerprint,
      organizationId: projects.organizationId,
    })
    .from(alerts)
    .innerJoin(projects, eq(projects.id, alerts.projectId))
    .where(eq(alerts.id, ALERT_ID!))
    .limit(1);

  if (!seed) {
    console.error(`Alert ${ALERT_ID} not found`);
    process.exit(1);
  }
  if (!seed.fingerprint) {
    console.error(`Alert ${ALERT_ID} has no fingerprint — fleet verification requires one`);
    process.exit(1);
  }
  if (!seed.organizationId) {
    console.error(`Alert's project has no organizationId — /sessions/[id] auth check will 404`);
    process.exit(1);
  }

  const [rem] = await db
    .select({
      id: remediationSessions.id,
      userId: remediationSessions.userId,
      mergedCommitSha: remediationSessions.mergedCommitSha,
      branch: remediationSessions.branch,
    })
    .from(remediationSessions)
    .where(eq(remediationSessions.alertId, ALERT_ID!))
    .orderBy(desc(remediationSessions.createdAt))
    .limit(1);

  if (!rem) {
    console.error(`No remediation found for alert ${ALERT_ID} — fleet requires a fix to verify against`);
    process.exit(1);
  }

  const fixCommitSha = rem.mergedCommitSha ?? `branch:${rem.branch ?? rem.id}`;

  console.log(`Seed target:`);
  console.log(`  Alert:          ${seed.alertId}`);
  console.log(`  Fingerprint:    ${seed.fingerprint}`);
  console.log(`  Project:        ${seed.projectId}`);
  console.log(`  Org:            ${seed.organizationId}`);
  console.log(`  Remediation:    ${rem.id}`);
  console.log(`  Fix commit sha: ${fixCommitSha}`);
  console.log(`  Siblings count: ${COUNT}`);
  console.log("");

  const ts = Date.now();
  // Distribution: ~90% matched, 10% would_not_prevent (at least 1).
  // Threshold is 90% so landing exactly there is the interesting demo.
  const wouldNotPreventCount = Math.max(1, Math.floor(COUNT * 0.1));
  let createdMatched = 0;
  let createdWouldNotPrevent = 0;

  // NOTE: we intentionally DON'T create new `alerts` rows per sibling.
  // The alerts table has a partial UNIQUE(project_id, fingerprint)
  // dedup index, so the fleet signal can't live there. Instead the
  // fleet query walks `replay_sessions.error_fingerprints` — a text[]
  // column where each session records the fingerprints it observed.
  // Creating replay_sessions + substrate_recordings + whatif_replays
  // is sufficient; the fingerprint propagates via the array column.
  for (let i = 0; i < COUNT; i++) {
    const siblingId = `demo-fleet-${ts}-${i.toString().padStart(2, "0")}`;
    const siblingRecordingId = `rec-${siblingId}`;

    const outcomeWillBeFail = i < wouldNotPreventCount;

    // 1. replay_session — error_fingerprints array carries the fleet
    //    signal. The worker's pickCandidateSessions reads this column.
    await db.insert(replaySessions).values({
      sessionId: siblingId,
      projectId: seed.projectId,
      organizationId: seed.organizationId,
      userId: rem.userId,
      startedAt: new Date(ts - (i + 1) * 60_000),
      endedAt: new Date(ts - i * 60_000),
      durationMs: 60_000,
      r2Prefix: `demo/fleet/${siblingId}`,
      blockCount: 0,
      totalBytes: 0,
      clickSelectors: ["button.checkout"],
      urlsVisited: ["/checkout"],
      errorFingerprints: [seed.fingerprint],
      frustrationScore: outcomeWillBeFail ? 90 : 30,
      browser: "Chrome",
      os: i % 2 === 0 ? "macOS" : "Windows",
      country: ["US", "MX", "BR", "DE", "JP"][i % 5],
    });

    // 2. substrate_recording — minimal payload. The worker skips this
    //    entirely when the whatif_replays cache hits (below), so we
    //    only need enough to pass the "has a recording" filter in
    //    pickCandidateSessions.
    await db.insert(substrateRecordings).values({
      recordingId: siblingRecordingId,
      projectId: seed.projectId,
      sessionId: siblingId,
      command: "node app.js",
      runtime: "node",
      startedAt: new Date(ts - (i + 1) * 60_000),
      endedAt: new Date(ts - i * 60_000),
      eventCount: 5,
      events: [{ seq: 1, timestamp_ns: 1_000_000, kind: { type: "process_start", pid: 1000 + i } }],
      durationMs: 60_000,
    });

    // 3. whatif_replays cache — short-circuits the worker's fleet
    //    runner so it doesn't attempt real clones of the fake repo.
    //    Shape matches WhatIfResult.substrate for the cache check.
    const cacheResult = outcomeWillBeFail
      ? buildFailCacheRow(i)
      : buildMatchCacheRow(i);

    await db.insert(whatifReplays).values({
      sessionId: siblingId,
      fixCommitSha,
      fixId: rem.id,
      status: "ready",
      result: cacheResult,
    }).onConflictDoNothing();

    if (outcomeWillBeFail) createdWouldNotPrevent++;
    else createdMatched++;
  }

  console.log(`Created ${COUNT} siblings:`);
  console.log(`  matched:            ${createdMatched}`);
  console.log(`  would_not_prevent:  ${createdWouldNotPrevent}`);
  console.log("");
  console.log(`Now open the alert page and click "Verify across fleet":`);
  console.log(`  /alerts/${seed.alertId}`);
}

// ── Cache row builders ────────────────────────────────────────────────────

function buildMatchCacheRow(i: number) {
  return {
    outcome: "would_prevent" as const,
    confidence: 95,
    riskScore: 10 + (i % 5),
    analysis: `Substrate replay matched the recorded I/O sequence for sibling #${i}. Fix preserves behavior cleanly.`,
    mode: "substrate_replay" as const,
    computedAt: new Date().toISOString(),
    substrate: {
      matched: true,
      eventCountBefore: 5,
      eventCountAfter: 5,
      riskLevel: "low" as const,
      blastRadius: { httpPaths: [], dbTables: [], filePaths: [], totalSurfaces: 0 },
      recommendations: ["Low risk — standard review sufficient"],
      divergences: [],
    },
  };
}

function buildFailCacheRow(i: number) {
  return {
    outcome: "would_not_prevent" as const,
    confidence: 70,
    riskScore: 88 + (i % 5),
    analysis: `Substrate replay diverged for sibling #${i}. Fix doesn't address the edge case this session hit.`,
    mode: "substrate_replay" as const,
    computedAt: new Date().toISOString(),
    substrate: {
      matched: false,
      eventCountBefore: 5,
      eventCountAfter: 3,
      riskLevel: "critical" as const,
      blastRadius: {
        httpPaths: ["/api/checkout"],
        dbTables: ["orders"],
        filePaths: [],
        totalSurfaces: 2,
      },
      recommendations: [
        "Critical divergence — orders table write missing after fix",
        "Review the edge case this session triggered before merging",
      ],
      divergences: [
        { category: "http_response_status", detail: "api.stripe.com: recorded 200, replayed 500" },
        { category: "db_query_missing", detail: "INSERT INTO orders was called before fix; now missing" },
      ],
    },
  };
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
