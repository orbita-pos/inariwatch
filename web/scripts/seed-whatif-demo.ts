/**
 * Seed two full What-If scenarios end-to-end.
 *
 * Creates the complete chain of rows that the What-If feature reads
 * from, PLUS a precomputed `whatif_replays` cache row so the UI
 * renders the full substrate_replay timeline without needing the
 * worker to actually clone + run substrate against a real repo.
 *
 * Two scenarios are produced:
 *   - "matched" — all events align, green timeline, would_prevent
 *   - "divergent" — 2 divergences, mixed green/amber/red, uncertain
 *
 * Usage:
 *   cd web && npx tsx scripts/seed-whatif-demo.ts --email <user-email>
 *
 * The script resolves the user's default project (first one they own).
 * Override the project with --project <slug> when needed.
 *
 * After seeding, the script prints two URLs:
 *   1. /alerts/[id] — see the alert detail with FullTrace card
 *   2. /sessions/[sessionId] — see the session player + AI panel with
 *      the Run What-If button; click it to render the timeline
 *
 * Teardown: re-running the script doesn't clean up prior seeds; delete
 * by hand via Drizzle Studio if needed. Each run gets unique IDs.
 */

import { randomUUID } from "node:crypto";
import { config as loadEnv } from "dotenv";
import { resolve as resolvePath } from "node:path";

// Next.js reads .env.local first by convention; dotenv needs an
// explicit path because this script runs outside the Next runtime.
loadEnv({ path: resolvePath(process.cwd(), ".env.local") });
loadEnv(); // fallback to .env if present

import { db } from "@/lib/db";
import {
  alerts,
  projects,
  remediationSessions,
  replaySessions,
  substrateRecordings,
  users,
  whatifReplays,
} from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

// ── CLI parsing ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function argOf(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const EMAIL = argOf("--email");
const PROJECT_SLUG = argOf("--project");

if (!EMAIL) {
  console.error("Usage: npx tsx scripts/seed-whatif-demo.ts --email <email> [--project <slug>]");
  process.exit(1);
}

// ── Resolve user + project ─────────────────────────────────────────────────

async function main() {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, EMAIL!)).limit(1);
  if (!user) {
    console.error(`No user found with email ${EMAIL}`);
    process.exit(1);
  }

  const projWhere = PROJECT_SLUG
    ? and(eq(projects.userId, user.id), eq(projects.slug, PROJECT_SLUG))
    : eq(projects.userId, user.id);
  const [project] = await db.select({
    id: projects.id,
    slug: projects.slug,
    name: projects.name,
    organizationId: projects.organizationId,
  })
    .from(projects).where(projWhere).limit(1);
  if (!project) {
    console.error(`No project found for user ${EMAIL}${PROJECT_SLUG ? ` with slug ${PROJECT_SLUG}` : ""}`);
    process.exit(1);
  }

  // /sessions/[sessionId] uses replay_sessions.organization_id for
  // both the authz check and the REPLAY_V2_ORGS feature flag gate.
  // Fall back ladder: project.org → user's owned org → user's membership.
  let organizationId = project.organizationId;
  if (!organizationId) {
    const { organizations: orgsTable, organizationMembers: membersTable } =
      await import("@/lib/db/schema");

    const [owned] = await db.select({ id: orgsTable.id })
      .from(orgsTable).where(eq(orgsTable.ownerId, user.id)).limit(1);
    if (owned) {
      organizationId = owned.id;
    } else {
      const [member] = await db.select({ id: membersTable.organizationId })
        .from(membersTable).where(eq(membersTable.userId, user.id)).limit(1);
      if (member) organizationId = member.id;
    }

    if (!organizationId) {
      console.error("User has no organization — /sessions/[id] auth check will fail. Create an org first.");
      process.exit(1);
    }

    // Wire the project to the resolved org so future seeds skip this
    // fallback. Idempotent — re-running won't harm anything.
    await db.update(projects)
      .set({ organizationId })
      .where(eq(projects.id, project.id));
  }

  console.log(`User:     ${EMAIL} (${user.id})`);
  console.log(`Project:  ${project.name} (slug=${project.slug})`);
  console.log(`Org:      ${organizationId}`);
  console.log("");

  await seedScenario({
    label: "matched",
    projectId: project.id,
    organizationId,
    userId: user.id,
    diverge: false,
  });

  await seedScenario({
    label: "divergent",
    projectId: project.id,
    organizationId,
    userId: user.id,
    diverge: true,
  });
}

// ── Scenario ──────────────────────────────────────────────────────────────

interface ScenarioInput {
  label: "matched" | "divergent";
  projectId: string;
  organizationId: string;
  userId: string;
  diverge: boolean;
}

async function seedScenario({ label, projectId, organizationId, userId, diverge }: ScenarioInput): Promise<void> {
  const ts = Date.now();
  const sessionId = `demo-whatif-${label}-${ts}`;
  const alertId = randomUUID();
  const remediationId = randomUUID();
  const recordingId = `rec-${sessionId}`;
  const mergedSha = `demo${Math.random().toString(16).slice(2, 14)}`;

  const startedAt = new Date(ts - 5 * 60 * 1000);
  const endedAt = new Date(ts - 4 * 60 * 1000);

  // 1. replay_sessions row — minimal shape; r2Prefix must be set even
  //    though we never upload rrweb blocks for the seed.
  await db.insert(replaySessions).values({
    sessionId,
    projectId,
    organizationId,
    userId,
    startedAt,
    endedAt,
    durationMs: 60_000,
    r2Prefix: `demo/seed/${sessionId}`,
    blockCount: 0,
    totalBytes: 0,
    clickSelectors: ["button.checkout", "input[name=email]"],
    urlsVisited: ["/checkout", "/api/pay"],
    errorFingerprints: [`whatif-${label}-fp-${ts}`],
    frustrationScore: diverge ? 75 : 10,
    browser: "Chrome",
    os: "macOS",
    country: "MX",
  });

  // 2. substrate_recordings — plausible event sequence. The UI doesn't
  //    inspect these at the seed level, but the worker and the cached
  //    whatif_replays result both reference them, so shape matches the
  //    Rust Event serialization (snake_case tagged union).
  const baseEvents = buildEventSequence();
  await db.insert(substrateRecordings).values({
    recordingId,
    projectId,
    sessionId,
    command: "node app.js",
    runtime: "node",
    startedAt,
    endedAt,
    eventCount: baseEvents.length,
    events: baseEvents,
    durationMs: 60_000,
  });

  // 3. alerts — carrying the same session_id that links it to the
  //    recording + replay session. Fingerprint seeds the impact card.
  await db.insert(alerts).values({
    id: alertId,
    projectId,
    // VAR Q1 session correlation — without this, the AI tab aggregator
    // returns empty and the "Run What-If" button never appears in the UI.
    sessionId,
    severity: "critical",
    title: diverge
      ? "TypeError: Cannot read property 'user' of undefined"
      : "RequestTimeout: Stripe charge took >30s",
    body: diverge
      ? "at src/middleware/auth.js:42 — session object accessed before hydration"
      : "at src/checkout/charge.js:87 — Stripe SDK default timeout hit under load",
    sourceIntegrations: ["capture"],
    aiReasoning: diverge
      ? "Null-check missing on session; occurs when user hits /checkout before auth middleware runs."
      : "No explicit timeout; default 30s; retry logic missing on idempotent charge calls.",
    fingerprint: `whatif-${label}-fp-${ts}`,
    alertType: "error",
  });

  // Sticky link back — replay_sessions.alertId sets up the "see this
  // session from the alert" deep link tests.
  await db.update(replaySessions)
    .set({ alertId })
    .where(eq(replaySessions.sessionId, sessionId));

  // 4. remediation_sessions — merged state with a fake SHA and
  //    fileChanges that the worker WOULD have cloned into. Status
  //    "completed" + mergedCommitSha present = eligible for What-If.
  await db.insert(remediationSessions).values({
    id: remediationId,
    alertId,
    projectId,
    userId,
    status: "completed",
    attempt: 1,
    maxAttempts: 3,
    repo: "orbita-pos/demo-whatif-fixture",
    branch: `fix/${alertId.slice(0, 8)}`,
    baseBranch: "main",
    mergedCommitSha: mergedSha,
    mergeStrategy: "auto_merged",
    confidenceScore: diverge ? 78 : 95,
    fileChanges: [
      {
        path: diverge ? "src/middleware/auth.js" : "src/checkout/charge.js",
        content: diverge
          ? "// seeded fix: add null check before accessing session.user\nexport function authMiddleware(req, res, next) { if (!req.session?.user) return res.status(401).end(); next(); }"
          : "// seeded fix: explicit 10s timeout + retry\nexport async function charge(amount) { return stripe.charges.create({ amount }, { timeout: 10_000, maxNetworkRetries: 2 }); }",
      },
    ],
    steps: [
      { phase: "diagnose", status: "completed", ts: startedAt.toISOString() },
      { phase: "generate_fix", status: "completed", ts: new Date(startedAt.getTime() + 60_000).toISOString() },
      { phase: "push", status: "completed", ts: new Date(startedAt.getTime() + 120_000).toISOString() },
      { phase: "merge", status: "completed", ts: endedAt.toISOString() },
    ],
    fingerprint: `whatif-${label}-fp-${ts}`,
  });

  // 5. whatif_replays — the precomputed cache row that makes the UI
  //    render substrate_replay mode without the worker actually running.
  //    Shape matches WhatIfResult exactly; the API route serves it on
  //    cache hit and the UI branches on mode === "substrate_replay".
  const cacheRow = diverge
    ? divergentCacheRow(baseEvents)
    : matchedCacheRow(baseEvents);

  await db.insert(whatifReplays).values({
    sessionId,
    fixCommitSha: mergedSha,
    fixId: remediationId,
    status: "ready",
    result: cacheRow,
  }).onConflictDoNothing();

  console.log(`[${label}]`);
  console.log(`  sessionId:      ${sessionId}`);
  console.log(`  alertId:        ${alertId}`);
  console.log(`  remediationId:  ${remediationId}`);
  console.log(`  mergedCommitSha ${mergedSha}`);
  console.log(`  → /alerts/${alertId}`);
  console.log(`  → /sessions/${encodeURIComponent(sessionId)}`);
  console.log("");
}

// ── Synthetic event builders ──────────────────────────────────────────────

function buildEventSequence(): Record<string, unknown>[] {
  // 20 plausible events mixing HTTP + DB + time. Stays small (~4KB JSON)
  // so the seed script runs fast, and the timeline has enough markers
  // for visual testing without overwhelming the SVG.
  const events: Record<string, unknown>[] = [];
  let t = 0;
  const tick = (inc: number) => { t += inc; return t; };

  events.push({ seq: 1, timestamp_ns: tick(100_000), kind: { type: "process_start", pid: 12345, argv: ["node", "app.js"], cwd: "/app" } });
  events.push({ seq: 2, timestamp_ns: tick(50_000_000), kind: { type: "time_now", ms: 1744934400000 } });
  events.push({ seq: 3, timestamp_ns: tick(1_000_000), kind: { type: "http_request", id: 1, method: "POST", url: "https://api.stripe.com/v1/charges" } });
  events.push({ seq: 4, timestamp_ns: tick(2_000_000), kind: { type: "db_query", id: 1, system: "postgres", query: "SELECT * FROM users WHERE id = $1" } });
  events.push({ seq: 5, timestamp_ns: tick(5_000_000), kind: { type: "db_query", id: 2, system: "postgres", query: "UPDATE orders SET status = $1 WHERE id = $2" } });
  events.push({ seq: 6, timestamp_ns: tick(3_000_000), kind: { type: "http_response", id: 1, status: 200 } });
  events.push({ seq: 7, timestamp_ns: tick(1_000_000), kind: { type: "file_read", path: "/app/config.json", bytes_read: 1024 } });
  events.push({ seq: 8, timestamp_ns: tick(2_000_000), kind: { type: "random_float", value: 0.5234 } });
  events.push({ seq: 9, timestamp_ns: tick(4_000_000), kind: { type: "http_request", id: 2, method: "GET", url: "https://api.segment.io/v1/track" } });
  events.push({ seq: 10, timestamp_ns: tick(8_000_000), kind: { type: "http_response", id: 2, status: 200 } });
  events.push({ seq: 11, timestamp_ns: tick(3_000_000), kind: { type: "dns_resolve", hostname: "api.stripe.com", addresses: ["23.23.23.23"] } });
  events.push({ seq: 12, timestamp_ns: tick(1_500_000), kind: { type: "time_now", ms: 1744934460000 } });
  events.push({ seq: 13, timestamp_ns: tick(5_000_000), kind: { type: "db_query", id: 3, system: "postgres", query: "INSERT INTO audit_log VALUES ($1, $2)" } });
  events.push({ seq: 14, timestamp_ns: tick(2_000_000), kind: { type: "file_write", path: "/tmp/session.lock", bytes_written: 64 } });
  events.push({ seq: 15, timestamp_ns: tick(6_000_000), kind: { type: "http_request", id: 3, method: "POST", url: "https://api.inariwatch.com/capture" } });
  events.push({ seq: 16, timestamp_ns: tick(10_000_000), kind: { type: "http_response", id: 3, status: 202 } });
  events.push({ seq: 17, timestamp_ns: tick(1_000_000), kind: { type: "marker", label: "checkout_complete" } });
  events.push({ seq: 18, timestamp_ns: tick(500_000), kind: { type: "time_now", ms: 1744934500000 } });
  events.push({ seq: 19, timestamp_ns: tick(2_000_000), kind: { type: "random_bytes", len: 32, hex: "ae5f..." } });
  events.push({ seq: 20, timestamp_ns: tick(100_000), kind: { type: "process_exit", code: 0 } });

  return events;
}

function matchedCacheRow(events: Record<string, unknown>[]) {
  return {
    outcome: "would_prevent" as const,
    confidence: 95,
    riskScore: 12,
    analysis: "Substrate replay matched the recorded I/O sequence exactly — the fix preserves behavior for every HTTP, DB, and file operation from the original session. Safe to merge with standard review.",
    mode: "substrate_replay" as const,
    computedAt: new Date().toISOString(),
    substrate: {
      matched: true,
      eventCountBefore: events.length,
      eventCountAfter: events.length,
      riskLevel: "low" as const,
      blastRadius: { httpPaths: [], dbTables: [], filePaths: [], totalSurfaces: 0 },
      recommendations: ["Low risk — standard review and testing should be sufficient"],
      recordedEvents: events,
      replayedEvents: events,
      divergences: [],
    },
  };
}

function divergentCacheRow(recorded: Record<string, unknown>[]) {
  // Replayed version differs at events 5 (DB query text) and 10 (HTTP status):
  //   recorded[4] UPDATE orders SET status  →  replayed[4] UPDATE orders SET status, retried_at
  //   recorded[9] http 200                  →  replayed[9] http 500
  // Both kind.type stay the same → classified as "kind_changed" by the
  // UI heuristic, showing amber markers. Plus 2 explicit divergences
  // for the list below the timeline.
  const replayed = recorded.map((e, i) => {
    const event = e as { kind: Record<string, unknown> };
    if (i === 4) {
      return {
        ...e,
        kind: { ...event.kind, query: "UPDATE orders SET status = $1, retried_at = $2 WHERE id = $3" },
      };
    }
    if (i === 9) {
      return { ...e, kind: { ...event.kind, status: 500 } };
    }
    return e;
  });

  return {
    outcome: "uncertain" as const,
    confidence: 70,
    riskScore: 55,
    analysis: "Substrate replay diverged at 2 points — a DB write gained a retry column, and one external API response flipped 200→500. Review the diff + monitor the charge endpoint in staging before full rollout.",
    mode: "substrate_replay" as const,
    computedAt: new Date().toISOString(),
    substrate: {
      matched: false,
      eventCountBefore: recorded.length,
      eventCountAfter: replayed.length,
      riskLevel: "medium" as const,
      blastRadius: {
        httpPaths: ["https://api.segment.io/v1/track"],
        dbTables: ["orders"],
        filePaths: [],
        totalSurfaces: 2,
      },
      recommendations: [
        "Review new/changed database queries for correctness and indexing",
        "Monitor latency in staging — significant timing shifts detected",
      ],
      recordedEvents: recorded,
      replayedEvents: replayed,
      divergences: [
        { category: "db_query_changed", detail: "orders UPDATE gained column `retried_at` — verify index + migration" },
        { category: "http_response_status", detail: "api.segment.io/v1/track: recorded 200, replayed 500" },
      ],
    },
  };
}

// ── Run ────────────────────────────────────────────────────────────────────

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
