/**
 * Code Intelligence v2 — dogfood seeder.
 *
 * Generates ~50 synthetic-but-realistic alerts whose stack traces specifically
 * exercise code intelligence retrieval (callers, type-flow, blast radius,
 * cross-file references). Each alert is inserted into `alerts` AND fed
 * through `autoAnalyzeAlert` → `runRemediation()`, so the data lands in:
 *
 *   - alerts                    (50 new rows tagged seed=codeintel-dogfood)
 *   - remediation_sessions      (full pipeline runs — turns, success, $)
 *   - ai_usage_logs             (per-call cost/latency)
 *   - code_intel_shadow_log     (when CODE_INTEL_V2=shadow on prod)
 *   - code_intel_remediation_ab (once Phase 3.2 lands the A/B routing)
 *
 * This is the "Anthropic startup playbook" applied to InariWatch:
 *   1. Self-hosting (capture is already wired to InariWatch via instrumentation.ts)
 *   2. Replay of incident shapes (fixtures here mimic real prod stack traces)
 *   3. Adversarial harness (fixtures include long-tail patterns: dynamic
 *      imports, declaration merging, polymorphic types, async waterfalls)
 *
 * Cost: ~$0.30 - $1.50 total for 50 fixtures depending on remediation depth.
 * Time: 10-30 minutes of wall clock once the worker starts processing.
 *
 * Usage:
 *   npx tsx scripts/seed-codeintel-dogfood.ts                  # default project
 *   npx tsx scripts/seed-codeintel-dogfood.ts --project <id>
 *   npx tsx scripts/seed-codeintel-dogfood.ts --count 20       # smaller batch
 *   npx tsx scripts/seed-codeintel-dogfood.ts --dry-run        # no DB writes
 *
 * Cleanup:
 *   npx tsx scripts/cleanup-codeintel-dogfood.ts
 *
 * Pairing with Phase 3:
 *   - Run BEFORE Phase 3 deploys → seeds the v1 baseline (turn count avg,
 *     success rate, $/fix). The cutover script needs these as the "v1 number
 *     v2 must beat".
 *   - Run AFTER Phase 3 with CODE_INTEL_V2=shadow → fills shadow_log too.
 *   - Run AFTER Phase 3 with CONTAINER_AGENT_AB_PCT=50 → fills remediation_ab.
 *     50 fixtures with 50/50 A/B = ~25 v1 + ~25 v2 samples per run. Two runs
 *     gets you to the CUTOVER_MIN_SAMPLES = 100 threshold.
 */

import { config } from "dotenv";
import path from "path";

config({ path: path.join(__dirname, "../.env.local") });

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "../lib/db/schema";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });

// ── Args ─────────────────────────────────────────────────────────────────────

interface Args {
  projectId?: string;
  count: number;
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { count: 50, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project") out.projectId = argv[++i];
    else if (a === "--count") out.count = Number.parseInt(argv[++i], 10) || 50;
    else if (a === "--dry-run" || a === "-n") out.dryRun = true;
    else if (a === "--help" || a === "-h") {
      console.log(`usage: seed-codeintel-dogfood [--project <id>] [--count 50] [--dry-run]`);
      process.exit(0);
    }
  }
  return out;
}

// ── Fixtures — 50 alerts that exercise code intelligence ─────────────────────
//
// Each fixture targets a specific v2 capability. Comments tag which v2 query
// would have helped most. v1 has to grep + read-file across the codebase
// to discover the same context.

interface DogfoodFixture {
  category: string;
  severity: "critical" | "warning" | "info";
  title: string;
  body: string;
  /** Which v2 query (find_references / type_at / blast_radius) v2 would use. */
  v2QueryHint: "find_references" | "type_at" | "blast_radius" | "search_semantic";
}

const FIXTURES: DogfoodFixture[] = [
  // ── find_references — caller graph (v1 grep is noisy with homonyms) ────────
  {
    category: "callers",
    severity: "critical",
    title: "TypeError: validateUser is not a function",
    body: `TypeError: validateUser is not a function
    at handler (app/api/auth/login/route.ts:23:12)
    at NextRequestHandler (.next/server/app/api/auth/login/route.js:51:14)

Recently renamed validateUser → validateCredentials in lib/auth/validators.ts
but 7 import sites still reference the old name across the codebase.
Production: 18 occurrences in last 5 minutes.`,
    v2QueryHint: "find_references",
  },
  {
    category: "callers",
    severity: "critical",
    title: "ReferenceError: notifyUser is not defined",
    body: `ReferenceError: notifyUser is not defined
    at processOrder (lib/orders/processor.ts:142:5)
    at handleCheckout (app/api/checkout/route.ts:88:21)

Symbol notifyUser was removed from lib/notifications/index.ts in commit 8a3f.
Build succeeded — TS thought it was unused. Production import via barrel
export bypassed the type-check.`,
    v2QueryHint: "find_references",
  },
  {
    category: "callers",
    severity: "warning",
    title: "TypeError: this.cache.invalidate is not a function",
    body: `TypeError: this.cache.invalidate is not a function
    at OrderService.refresh (lib/services/order.service.ts:67:18)
    at processWebhook (app/api/webhooks/stripe/route.ts:142:14)

Cache interface contract changed (invalidate → invalidateKey) but 4 service
classes still call .invalidate(). Migration was incomplete.`,
    v2QueryHint: "find_references",
  },

  // ── type_at — type at a specific call site (v1 has no type info) ───────────
  {
    category: "type-flow",
    severity: "critical",
    title: "TypeError: Cannot read properties of undefined (reading 'email')",
    body: `TypeError: Cannot read properties of undefined (reading 'email')
    at sendReceipt (lib/email/sender.ts:34:23)
    at processOrder (lib/orders/processor.ts:189:5)

processOrder passes order.customer to sendReceipt expecting Customer, but
order.customer is Customer | null on the OrderWithCustomer type. Missing null
guard. Recent type narrowing in lib/db/types.ts widened the relation.`,
    v2QueryHint: "type_at",
  },
  {
    category: "type-flow",
    severity: "critical",
    title: "TypeError: response.json is not a function",
    body: `TypeError: response.json is not a function
    at fetchUserSettings (lib/api/users.ts:45:32)

Caller passes the raw Response.body (ReadableStream) instead of awaiting
.json(). The type system thinks fetchUserSettings receives Response but it
receives ReadableStream<Uint8Array>. Likely a refactor that changed the
fetch wrapper signature.`,
    v2QueryHint: "type_at",
  },
  {
    category: "type-flow",
    severity: "warning",
    title: "TypeError: Cannot destructure property 'id' of 'session.user'",
    body: `TypeError: Cannot destructure property 'id' of 'session.user' as it is undefined.
    at POST (app/api/comments/route.ts:18:13)

session.user has type Session["user"] which is { id?: string } | undefined.
Code assumes always-defined. Two other endpoints have the same pattern.`,
    v2QueryHint: "type_at",
  },

  // ── blast_radius — what depends on this symbol (v1 grep misses transitive) ─
  {
    category: "blast-radius",
    severity: "critical",
    title: "Build failed: 47 TS errors after refactoring User type",
    body: `Build failed: 47 TypeScript errors

After splitting User into UserPublic + UserPrivate in lib/db/types.ts,
downstream consumers in 23 files broke because they accessed .email
(now on UserPrivate only).

Affected: app/api/users/**, lib/services/user.service.ts, components/UserCard.tsx
and 20 more across the dashboard.`,
    v2QueryHint: "blast_radius",
  },
  {
    category: "blast-radius",
    severity: "warning",
    title: "Drizzle migration broke 12 select queries",
    body: `Drizzle ORM error: Property 'created_at' does not exist on type Alert.

Schema migration 0079 renamed alerts.createdAt → alerts.created_at to match
DB convention, but the Drizzle entry kept the old field. 12 places reference
alerts.createdAt directly.

The blast radius wasn't measured before the rename.`,
    v2QueryHint: "blast_radius",
  },

  // ── search_semantic — find code by intent, not by keyword ──────────────────
  {
    category: "semantic-search",
    severity: "critical",
    title: "RangeError: Maximum call stack size exceeded in recursive normalize",
    body: `RangeError: Maximum call stack size exceeded
    at normalize (lib/utils/normalize.ts:23:12)
    at normalize (lib/utils/normalize.ts:28:15)

User profile contains a circular self-reference (user.manager.reports[0] === user).
The normalize utility has no cycle detection. Need to find all places that
build user trees to add a Set guard.`,
    v2QueryHint: "search_semantic",
  },
  {
    category: "semantic-search",
    severity: "critical",
    title: "Race condition: order processed twice within 50ms",
    body: `Order order_abc123 was processed twice within 50ms.

Two concurrent webhook deliveries from Stripe both passed the
isProcessed = false check before either set isProcessed = true.

Need to find all "check then set" patterns in the codebase that lack
SELECT FOR UPDATE or distributed lock.`,
    v2QueryHint: "search_semantic",
  },

  // ── Async/promise handling ─────────────────────────────────────────────────
  {
    category: "async",
    severity: "critical",
    title: "UnhandledPromiseRejection: Failed to write substrate recording",
    body: `UnhandledPromiseRejection: Error: ENOSPC: no space left on device
    at writeSubstrateRecording (lib/services/substrate.service.ts:88:11)

The fire-and-forget call from the recording flusher swallows the rejection.
Other writes in the codebase do await + try/catch. Inconsistent error handling
patterns across substrate paths.`,
    v2QueryHint: "find_references",
  },
  {
    category: "async",
    severity: "warning",
    title: "Promise.all rejected entire batch on one item fail",
    body: `Promise.all in batchProcessAlerts rejected the whole 50-alert batch
because alert #23 had a malformed body. 49 valid alerts were skipped.

Should be Promise.allSettled. Need to find all Promise.all over user-input
arrays in the codebase.`,
    v2QueryHint: "search_semantic",
  },

  // ── Imports / module resolution ────────────────────────────────────────────
  {
    category: "imports",
    severity: "critical",
    title: "Module not found: '@/lib/ai/legacy-client' from 4 files",
    body: `Module not found: Can't resolve '@/lib/ai/legacy-client'

The file was deleted in commit 8a3f after migrating to @inariwatch/ai-router,
but 4 files still import it via barrel re-exports that didn't get cleaned up.

Build fails on Vercel.`,
    v2QueryHint: "find_references",
  },
  {
    category: "imports",
    severity: "warning",
    title: "Circular dependency: services/order ↔ services/customer",
    body: `Circular dependency detected:
  lib/services/order.service.ts → lib/services/customer.service.ts → lib/services/order.service.ts

Both services need to call helpers from each other. Solution requires
extracting the shared helpers into a third module — but which functions
need to move?`,
    v2QueryHint: "blast_radius",
  },

  // ── Database / drizzle ─────────────────────────────────────────────────────
  {
    category: "database",
    severity: "critical",
    title: "PostgresError: column 'embedding_model_version' does not exist",
    body: `PostgresError: column "embedding_model_version" does not exist
    at indexRepository (lib/code-intelligence/indexer.ts:189:22)

Migration 0078 added the column but staging DB hasn't been migrated.
The indexer assumes the column exists.

Need to find all code paths that read/write code_chunks columns added
post-migration-0028 to ensure they handle the schema-version mismatch.`,
    v2QueryHint: "find_references",
  },

  // ── React/JSX edge cases ───────────────────────────────────────────────────
  {
    category: "react",
    severity: "warning",
    title: "Hydration mismatch: server rendered <div> client rendered <span>",
    body: `Hydration mismatch in <UserBadge>:
  server: <div className="badge">Pro</div>
  client: <span className="badge">Pro</span>

The component uses a different HTML element based on props.tier, but the
server has tier='free' (default) and the client has tier from session.

Component is used in 14 places — need to find which call sites pass tier
asynchronously.`,
    v2QueryHint: "find_references",
  },
  {
    category: "react",
    severity: "warning",
    title: "useEffect ran 47 times in 100ms",
    body: `useEffect in components/AlertList.tsx:67 ran 47 times in 100ms.

The dependency array contains an object literal { workspaceId, severity }
which is recreated on every render. Need to find all useEffect blocks
across the dashboard that have this anti-pattern.`,
    v2QueryHint: "search_semantic",
  },

  // ── Auth/session ───────────────────────────────────────────────────────────
  {
    category: "auth",
    severity: "critical",
    title: "Session.user.id is string in dev, undefined in prod",
    body: `Session.user.id resolves to string in dev (NextAuth dev session)
but undefined in prod (NextAuth JWT session — the callback strips it).

Routes that destructure session.user.id work in dev, fail in prod.
Affects 9 API routes and 3 server actions.`,
    v2QueryHint: "find_references",
  },

  // ── Adding more fixtures to hit count 50 ───────────────────────────────────
  // Each block of 5 below targets one v2 query type to keep the corpus balanced.

  // 5 more find_references
  {
    category: "callers",
    severity: "critical",
    title: "TypeError: Cannot find name 'computeFingerprint'",
    body: `TypeError: computeFingerprint is not a function
    at deduplicateAlert (lib/services/dedup.service.ts:34:18)

Function was renamed but a barrel export still exposed the old name. 6 callers.`,
    v2QueryHint: "find_references",
  },
  {
    category: "callers",
    severity: "warning",
    title: "Removed feature flag still referenced in 8 files",
    body: `Feature flag NEW_REMEDIATION_PIPELINE was removed last week.
8 files still reference flags.NEW_REMEDIATION_PIPELINE.`,
    v2QueryHint: "find_references",
  },
  {
    category: "callers",
    severity: "info",
    title: "Telegram bot helper sendOrEdit removed without cleanup",
    body: `lib/telegram/send.ts:sendOrEdit was deleted in favor of
sendInariLensFormatted. Linter missed 3 internal callers.`,
    v2QueryHint: "find_references",
  },
  {
    category: "callers",
    severity: "warning",
    title: "Removed Slack action handler still wired to event router",
    body: `Slack action 'mute_alert_legacy' was removed from web/lib/slack/actions.ts.
The events router (web/app/api/slack/events/route.ts) still dispatches to it.`,
    v2QueryHint: "find_references",
  },
  {
    category: "callers",
    severity: "warning",
    title: "Capture SDK breadcrumbs API breaking change unreferenced",
    body: `addBreadcrumb signature changed from (msg) to (msg, opts).
2 first-party usages still pass single arg. TS missed because of any.`,
    v2QueryHint: "find_references",
  },

  // 5 more type_at
  {
    category: "type-flow",
    severity: "critical",
    title: "TypeError on integration.config.token after schema split",
    body: `Property 'token' does not exist on type 'IntegrationConfig'.
After the union split (GithubConfig | VercelConfig | DatadogConfig),
generic .token access broke in 6 places.`,
    v2QueryHint: "type_at",
  },
  {
    category: "type-flow",
    severity: "critical",
    title: "Drizzle relation returns undefined when row is null",
    body: `db.query.alerts.findFirst with relation 'project' returned
undefined when project_id is null. Code assumed Project not null.`,
    v2QueryHint: "type_at",
  },
  {
    category: "type-flow",
    severity: "warning",
    title: "Generic helper called with mismatched type parameter",
    body: `paginate<Alert>(query) was called with paginate<AlertWithProject>
in 4 places. The narrower Alert type is missing the joined fields.`,
    v2QueryHint: "type_at",
  },
  {
    category: "type-flow",
    severity: "warning",
    title: "Optional chain bypasses required-field check",
    body: `user?.email was used where user.email is required (after auth gate).
TS allows this but downstream null-checks contradict the gate.`,
    v2QueryHint: "type_at",
  },
  {
    category: "type-flow",
    severity: "info",
    title: "Discriminated union narrowed by wrong tag",
    body: `Alert event narrowing by alert.kind misses the new 'aborted' variant
introduced by the BullMQ migration.`,
    v2QueryHint: "type_at",
  },

  // 5 more blast_radius
  {
    category: "blast-radius",
    severity: "critical",
    title: "Renaming Project.workspaceId broke 31 queries",
    body: `Drizzle column rename Project.workspaceId → Project.organizationId
broke 31 select chains. Migration script missed the WhereClause helpers.`,
    v2QueryHint: "blast_radius",
  },
  {
    category: "blast-radius",
    severity: "warning",
    title: "Switching enum value 'queued' → 'pending' missed 9 sites",
    body: `code_repo_status enum value renamed in 0079. 9 callers still
compare against 'queued'. Silent failures.`,
    v2QueryHint: "blast_radius",
  },
  {
    category: "blast-radius",
    severity: "warning",
    title: "Changing remediate.ts return shape broke 12 consumers",
    body: `runRemediation now returns { sessionId, status, attempts } instead
of just sessionId. 12 callers destructure incorrectly.`,
    v2QueryHint: "blast_radius",
  },
  {
    category: "blast-radius",
    severity: "warning",
    title: "Splitting Worker into Producer + Consumer broke imports",
    body: `lib/queue/worker.ts split into producer.ts + consumer.ts.
17 files import the old single Worker default export.`,
    v2QueryHint: "blast_radius",
  },
  {
    category: "blast-radius",
    severity: "info",
    title: "Removing default export from chat route broke 3 tests",
    body: `web/app/api/chat/route.ts no longer exports default. 3 vitest
specs still import default and crash on module load.`,
    v2QueryHint: "blast_radius",
  },

  // 5 more semantic_search
  {
    category: "semantic-search",
    severity: "warning",
    title: "All places that mutate session.user without re-signing JWT",
    body: `Audit revealed: session.user is mutated in 4 places without
re-signing the JWT. Causes session/JWT drift on next request.`,
    v2QueryHint: "search_semantic",
  },
  {
    category: "semantic-search",
    severity: "warning",
    title: "Find all setTimeout / setInterval not cleared on unmount",
    body: `React leak audit needs a list of every setTimeout / setInterval
inside useEffect that lacks a clearTimeout / clearInterval cleanup.`,
    v2QueryHint: "search_semantic",
  },
  {
    category: "semantic-search",
    severity: "info",
    title: "List every fetch() that lacks AbortSignal.timeout",
    body: `Risk: hung outbound fetches blocking the worker. Need an audit
of all fetch() calls in lib/services/* that don't pass signal: AbortSignal.timeout.`,
    v2QueryHint: "search_semantic",
  },
  {
    category: "semantic-search",
    severity: "warning",
    title: "Inconsistent error sanitization across log call sites",
    body: `Some console.error calls strip secrets via sanitizeError(), others
log raw errors. Need a uniform pattern across web/lib/.`,
    v2QueryHint: "search_semantic",
  },
  {
    category: "semantic-search",
    severity: "info",
    title: "Catch all Drizzle queries that omit .limit()",
    body: `Unbounded selects can OOM Neon worker. Need a list of every
db.select() chain that doesn't end with .limit() or .findFirst().`,
    v2QueryHint: "search_semantic",
  },

  // Filler — async + imports + db variety to balance to 50
  {
    category: "async",
    severity: "warning",
    title: "Race in BullMQ job: alert ack before persistence",
    body: `Worker calls job.complete() before await db.update finishes.
On crash, alert is ACKed but DB row not updated.`,
    v2QueryHint: "find_references",
  },
  {
    category: "async",
    severity: "info",
    title: "Background task started without tracking",
    body: `void backgroundCleanup() launched without await or tracking.
Worker SIGTERM mid-task → orphaned state.`,
    v2QueryHint: "search_semantic",
  },
  {
    category: "imports",
    severity: "warning",
    title: "Circular import: capture/intent/typescript ↔ capture/types",
    body: `Circular import causes the TS resolver to see capture/intent/typescript
exports as undefined at boot in some bundler modes.`,
    v2QueryHint: "blast_radius",
  },
  {
    category: "database",
    severity: "warning",
    title: "Foreign key cascade missing on code_chunks → code_repositories",
    body: `Deleting a code_repository orphaned 12k code_chunks rows.
ON DELETE CASCADE is missing on the FK.`,
    v2QueryHint: "find_references",
  },
  {
    category: "react",
    severity: "info",
    title: "Server component tried to call client-only hook",
    body: `app/(dashboard)/settings/page.tsx — server component imported
useState transitively via lib/ui/form.ts. Build warning, runtime ok.`,
    v2QueryHint: "blast_radius",
  },

  // Fillers to reach 50 — biased toward type_at + remaining categories
  {
    category: "type-flow",
    severity: "warning",
    title: "Inferred 'any' from JSON.parse leaked through 5 helpers",
    body: `JSON.parse returns any; helper chain propagated it. Runtime
TypeError when consumer accessed .nested without a type guard.`,
    v2QueryHint: "type_at",
  },
  {
    category: "type-flow",
    severity: "warning",
    title: "Conditional type narrows wrong branch on null payload",
    body: `Discriminated union T extends { kind: 'a' } ? A : B narrowed to A
when payload was null because of as cast. Runtime TypeError.`,
    v2QueryHint: "type_at",
  },
  {
    category: "type-flow",
    severity: "info",
    title: "Generic constraint <T extends keyof Schema> too permissive",
    body: `Generic accepted any string key including private columns. Caller
unintentionally selected sensitive fields.`,
    v2QueryHint: "type_at",
  },
  {
    category: "type-flow",
    severity: "warning",
    title: "Type guard isUser() returned wrong narrowed type",
    body: `User-defined type guard returned 'val is User' but logic only
checked one of three required fields. Downstream code assumed full User.`,
    v2QueryHint: "type_at",
  },
  {
    category: "callers",
    severity: "warning",
    title: "Helper renamed in lib/code-intelligence-v2 broke private callers",
    body: `searchCodebase → searchSemantic rename in v2 module missed 3
internal call sites that bypass the public re-export.`,
    v2QueryHint: "find_references",
  },
  {
    category: "blast-radius",
    severity: "info",
    title: "Adding required prop to <AlertCard> broke 7 tests",
    body: `<AlertCard> gained required prop 'onAck'. 7 vitest specs render
the component without it. TS-ignored in tests so build passed.`,
    v2QueryHint: "blast_radius",
  },
  {
    category: "semantic-search",
    severity: "warning",
    title: "Audit: every place that reads INARIWATCH_DSN without sanitizing",
    body: `Need an audit of all reads of process.env.INARIWATCH_DSN that
log it directly. Risk of leaking the DSN into Sentry / structured logs.`,
    v2QueryHint: "search_semantic",
  },
];

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  // Resolve project
  let projectId = args.projectId;
  if (!projectId) {
    const rows = await db
      .select({ id: schema.projects.id, name: schema.projects.name })
      .from(schema.projects)
      .limit(1);
    if (rows.length === 0) {
      console.error("No projects found. Pass --project <id> or create a project first.");
      process.exit(1);
    }
    projectId = rows[0].id;
    console.log(`Using project "${rows[0].name}" (${projectId})`);
  }

  const dogfoodRun = new Date().toISOString();
  const createdIds: string[] = [];
  const fixtures = FIXTURES.slice(0, args.count);

  console.log(`\nSeeding ${fixtures.length} code-intel dogfood alerts (run=${dogfoodRun}):\n`);

  let autoAnalyzeAlert:
    | ((alert: typeof schema.alerts.$inferSelect) => Promise<void>)
    | null = null;

  if (!args.dryRun) {
    try {
      const mod = await import("../lib/ai/auto-analyze");
      autoAnalyzeAlert = mod.autoAnalyzeAlert;
    } catch (err) {
      console.error("⚠  Could not import autoAnalyzeAlert — alerts will be inserted but NOT analyzed.");
      console.error("    Error:", err instanceof Error ? err.message : err);
    }
  }

  // Tally per v2QueryHint to confirm balance
  const tally: Record<string, number> = {};

  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i];
    tally[f.v2QueryHint] = (tally[f.v2QueryHint] ?? 0) + 1;
    const label = `[${String(i + 1).padStart(2, "0")}/${fixtures.length}] ${f.category.padEnd(16)} ${f.v2QueryHint.padEnd(16)} ${f.severity.padEnd(8)}`;

    if (args.dryRun) {
      console.log(`${label} ${f.title.slice(0, 60)}`);
      continue;
    }

    try {
      const t0 = Date.now();
      const [inserted] = await db
        .insert(schema.alerts)
        .values({
          projectId,
          severity: f.severity,
          title: f.title,
          body: f.body,
          sourceIntegrations: ["sentry"],
          correlationData: {
            seed: "codeintel-dogfood",
            dogfoodRun,
            category: f.category,
            v2QueryHint: f.v2QueryHint,
            fixtureIndex: i,
          },
        })
        .returning();

      createdIds.push(inserted.id);

      if (autoAnalyzeAlert) {
        try {
          await autoAnalyzeAlert(inserted);
          const ms = Date.now() - t0;
          console.log(`${label} ${inserted.id.slice(0, 8)}… ✓ analyzed (${ms}ms)`);
        } catch (err) {
          console.log(`${label} ${inserted.id.slice(0, 8)}… ⚠ analyze failed: ${err instanceof Error ? err.message : err}`);
        }
      } else {
        console.log(`${label} ${inserted.id.slice(0, 8)}… inserted (no analyzer)`);
      }
    } catch (err) {
      console.error(`${label} ✗ insert failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\nDone. Inserted ${createdIds.length}/${fixtures.length}.`);
  console.log(`v2 query distribution:`, tally);
  console.log(`\nCleanup: npx tsx scripts/cleanup-codeintel-dogfood.ts --run ${dogfoodRun}`);

  if (createdIds.length > 0) {
    console.log(`\nQuery the resulting baseline:`);
    console.log(`  SELECT severity, count(*) FROM alerts`);
    console.log(`   WHERE correlation_data->>'seed' = 'codeintel-dogfood'`);
    console.log(`     AND correlation_data->>'dogfoodRun' = '${dogfoodRun}'`);
    console.log(`   GROUP BY severity;`);
    console.log(`\nOnce remediations finish (10-30 min), check the v1 baseline:`);
    console.log(`  SELECT AVG(turn_count), AVG(CASE WHEN status='succeeded' THEN 1 ELSE 0 END)`);
    console.log(`    FROM remediation_sessions rs`);
    console.log(`    JOIN alerts a ON a.id = rs.alert_id`);
    console.log(`   WHERE a.correlation_data->>'dogfoodRun' = '${dogfoodRun}';`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
