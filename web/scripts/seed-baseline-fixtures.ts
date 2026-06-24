/**
 * Seed baseline fixtures for the GPT-5.4 "mejor del mundo" migration.
 *
 * Creates ~30 realistic alert fixtures labeled with `correlationData.seed = true`
 * and `correlationData.baselineRun = "<timestamp>"`, then enqueues each one
 * through the normal `post-alert-created` BullMQ job. The worker picks them
 * up and runs the real AI pipeline (auto-analyze, potentially remediation
 * depending on project config) — so the ai_usage_logs rows are REAL calls
 * through your actual stack (gpt-4o-mini → gpt-5.4 cascade).
 *
 * Costs: ~$0.15-0.40 total for 30 fixtures. Completion time: ~5-10 minutes
 * once the worker starts processing.
 *
 * Usage:
 *   npx tsx scripts/seed-baseline-fixtures.ts              # uses first project
 *   npx tsx scripts/seed-baseline-fixtures.ts --project <id>
 *   npx tsx scripts/seed-baseline-fixtures.ts --count 30
 *
 * Cleanup:
 *   npx tsx scripts/cleanup-baseline-seed.ts
 */

import { config } from "dotenv";
import path from "path";

config({ path: path.join(__dirname, "../.env.local") });

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "../lib/db/schema";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });

// ── Alert fixtures — realistic variety ─────────────────────────────────────

interface AlertFixture {
  severity: "critical" | "warning" | "info";
  title: string;
  body: string;
  sourceIntegrations: string[];
  category: string;
}

const FIXTURES: AlertFixture[] = [
  // Null/undefined (5) — the bread and butter of production JS errors
  {
    category: "null-ref",
    severity: "critical",
    title: "TypeError: Cannot read properties of undefined (reading 'email')",
    body: `Error: Cannot read properties of undefined (reading 'email')
    at UserProfile (app/dashboard/profile/page.tsx:34:23)
    at renderWithHooks (node_modules/react-dom/cjs/react-dom.development.js:14985:18)
    at mountIndeterminateComponent (node_modules/react-dom/cjs/react-dom.development.js:17811:13)

Environment: production · Node 22.x · Next 15.0.3
User: u_xc8bK2mN · Session: s_9mP3qW
Request: GET /dashboard/profile`,
    sourceIntegrations: ["sentry"],
  },
  {
    category: "null-ref",
    severity: "critical",
    title: "TypeError: Cannot destructure property 'id' of 'session.user'",
    body: `TypeError: Cannot destructure property 'id' of 'session.user' as it is undefined.
    at POST (app/api/comments/route.ts:18:13)
    at NextMiddleware.run (.next/server/middleware.js:52:14)

Route: POST /api/comments
Auth: session exists but session.user missing`,
    sourceIntegrations: ["sentry"],
  },
  {
    category: "null-ref",
    severity: "warning",
    title: "TypeError: Cannot read properties of null (reading 'toLowerCase')",
    body: `TypeError: Cannot read properties of null (reading 'toLowerCase')
    at formatSlug (lib/utils/slug.ts:12:24)
    at POST (app/api/posts/route.ts:45:27)

Input: { title: null, body: "Hello world" }`,
    sourceIntegrations: ["sentry"],
  },
  {
    category: "null-ref",
    severity: "warning",
    title: "TypeError: undefined is not a function at Array.map in /api/users",
    body: `TypeError: undefined is not a function
    at Array.map (<anonymous>)
    at GET (app/api/users/route.ts:28:34)

users.map(u => u.transform()) — transform is not defined on the User type`,
    sourceIntegrations: ["sentry"],
  },
  {
    category: "null-ref",
    severity: "critical",
    title: "TypeError: Cannot read property 'data' of undefined after API refactor",
    body: `TypeError: Cannot read property 'data' of undefined
    at fetchUserData (lib/api/users.ts:67:18)
    at async handler (app/api/profile/route.ts:23:22)

Recent change: commit abc1234 removed the data wrapper from the API response.`,
    sourceIntegrations: ["sentry", "github"],
  },

  // Async/timeout (5)
  {
    category: "timeout",
    severity: "critical",
    title: "RequestTimeout: Stripe charge took >30s",
    body: `RequestTimeout: Request to https://api.stripe.com/v1/charges timed out after 30000ms
    at createCharge (lib/payments/stripe.ts:42:14)
    at POST (app/api/checkout/route.ts:89:22)

Session: cs_9xK2mN · Customer: cus_pWqR3mN
Retry count: 2 of 3`,
    sourceIntegrations: ["sentry"],
  },
  {
    category: "timeout",
    severity: "critical",
    title: "TimeoutError: Database query exceeded 15s in /api/reports",
    body: `TimeoutError: Query execution exceeded 15000ms
    at executeQuery (lib/db/query.ts:89:11)
    at GET (app/api/reports/route.ts:34:18)

Query: SELECT * FROM events WHERE project_id = $1 ORDER BY created_at DESC
Missing index: (project_id, created_at)`,
    sourceIntegrations: ["datadog", "sentry"],
  },
  {
    category: "timeout",
    severity: "warning",
    title: "UnhandledPromiseRejection: Fetch aborted after 10s to /api/enrich",
    body: `UnhandledPromiseRejection: This operation was aborted
    at async enrichAlert (lib/ai/enrich.ts:23:14)
    at async POST (app/api/webhooks/sentry/route.ts:156:11)

AbortSignal.timeout(10000) triggered — enrich endpoint unresponsive`,
    sourceIntegrations: ["sentry"],
  },
  {
    category: "timeout",
    severity: "critical",
    title: "Redis SET timeout after 500ms in dedup path",
    body: `Error: Command timed out
    at handleTimeout (node_modules/ioredis/built/command.js:145:22)
    at Command.execute (node_modules/ioredis/built/command.js:99:18)

Command: SET alert:dedup:fp-abc123 1 NX EX 86400
Load avg: 4.2 on inari-web-redis`,
    sourceIntegrations: ["datadog"],
  },
  {
    category: "timeout",
    severity: "warning",
    title: "Request timeout: external HTTP call to sentry.io/api exceeded 8s",
    body: `TimeoutError: fetch to https://sentry.io/api/0/projects/acme/issues/ timed out
    at async pollSentry (lib/pollers/sentry.ts:56:18)

Retry will schedule in 2min`,
    sourceIntegrations: ["sentry"],
  },

  // Type/import errors (5)
  {
    category: "type-import",
    severity: "critical",
    title: "Module not found: Can't resolve '@/lib/auth/session'",
    body: `Module not found: Can't resolve '@/lib/auth/session'
./app/dashboard/layout.tsx:3:1

Recent change: lib/auth/session.ts was deleted in commit def5678 but imports weren't cleaned up.`,
    sourceIntegrations: ["github", "vercel"],
  },
  {
    category: "type-import",
    severity: "warning",
    title: "TS2322: Type 'string | null' is not assignable to type 'string'",
    body: `Type error: Type 'string | null' is not assignable to type 'string'.
./app/api/search/route.ts:34:22

  32 |   const query = searchParams.get('q')
  33 |   const results = await searchDocs({
> 34 |     query,
     |     ^^^^^
  35 |     limit: 20,
  36 |   })

searchParams.get() returns string | null but searchDocs expects string.`,
    sourceIntegrations: ["vercel", "github"],
  },
  {
    category: "type-import",
    severity: "critical",
    title: "ReferenceError: validateRequest is not defined",
    body: `ReferenceError: validateRequest is not defined
    at POST (app/api/subscribe/route.ts:12:3)

validateRequest was imported from lib/auth/validate but the file was moved to lib/security/validate.`,
    sourceIntegrations: ["sentry"],
  },
  {
    category: "type-import",
    severity: "warning",
    title: "Cannot find name 'NextRequest' in app/api/health/route.ts",
    body: `Type error: Cannot find name 'NextRequest'.
./app/api/health/route.ts:4:32

  export async function GET(req: NextRequest) {
                             ^^^^^^^^^^^

Missing import: import type { NextRequest } from "next/server"`,
    sourceIntegrations: ["vercel"],
  },
  {
    category: "type-import",
    severity: "critical",
    title: "TS2339: Property 'session' does not exist on type 'Request'",
    body: `Type error: Property 'session' does not exist on type 'Request'.
./app/api/admin/users/route.ts:14:23

  14 |   const userId = req.session?.user?.id
                         ^^^^^^^^^^^

Use getServerSession(authOptions) instead — legacy req.session was removed.`,
    sourceIntegrations: ["vercel"],
  },

  // Auth/validation (4)
  {
    category: "auth",
    severity: "critical",
    title: "Unauthorized: JWT verification failed in /api/admin/*",
    body: `JsonWebTokenError: invalid signature
    at verify (node_modules/jsonwebtoken/verify.js:147:17)
    at middleware (middleware.ts:28:14)

JWT secret may have rotated without invalidating existing tokens.
Affected: 3 users in last 5min.`,
    sourceIntegrations: ["sentry"],
  },
  {
    category: "auth",
    severity: "warning",
    title: "ZodError: Invalid email format in POST /api/invites",
    body: `ZodError: [
  {
    "code": "invalid_string",
    "validation": "email",
    "message": "Invalid email",
    "path": ["email"]
  }
]

Request body: { "email": "not-an-email", "role": "admin" }
Route missing: explicit email sanitization before schema validation.`,
    sourceIntegrations: ["sentry"],
  },
  {
    category: "auth",
    severity: "critical",
    title: "Rate limit bypass: /api/auth/login exceeded 100 req/min from single IP",
    body: `Rate limit triggered
    Source IP: 203.0.113.45
    Endpoint: POST /api/auth/login
    Requests in last minute: 247
    Consecutive failed logins: 89

Defensive: middleware should drop requests after 5 failed logins per IP/10min.`,
    sourceIntegrations: ["datadog"],
  },
  {
    category: "auth",
    severity: "warning",
    title: "CSRF token missing on POST /api/settings/update",
    body: `CSRFTokenMismatch: Missing csrf_token in request
    at verifyCSRF (lib/security/csrf.ts:18:15)
    at POST (app/api/settings/update/route.ts:8:14)

Frontend may have stale session; token expiry = 1h.`,
    sourceIntegrations: ["sentry"],
  },

  // Business logic (5)
  {
    category: "business",
    severity: "critical",
    title: "DatabaseIntegrityError: FK constraint failed on subscription insert",
    body: `PostgresError: insert or update on table "subscriptions" violates foreign key constraint "subscriptions_project_id_fkey"
    at async createSubscription (lib/db/subscriptions.ts:34:18)
    at POST (app/api/projects/[id]/upgrade/route.ts:42:22)

Project was deleted between checkout start and subscription insert.`,
    sourceIntegrations: ["sentry"],
  },
  {
    category: "business",
    severity: "warning",
    title: "Off-by-one: pagination returning duplicate items at page boundary",
    body: `Logic bug: paginated query returning same row on page N and N+1

Query: SELECT * FROM alerts ORDER BY created_at DESC LIMIT 20 OFFSET $1
Input: offset=40 returns item that also appeared at offset=39

Likely cause: ties in created_at (ms precision) and no secondary sort on id.`,
    sourceIntegrations: ["sentry"],
  },
  {
    category: "business",
    severity: "critical",
    title: "Race condition: duplicate remediation session created for same alert",
    body: `UniqueViolationError: duplicate key value violates unique constraint "remediation_sessions_alert_id_unique"

Two concurrent requests to /api/remediation/start for alert alr_abc123 both passed the existence check, then both tried INSERT.

Fix: wrap check+insert in transaction with SELECT ... FOR UPDATE, or use ON CONFLICT DO NOTHING.`,
    sourceIntegrations: ["sentry"],
  },
  {
    category: "business",
    severity: "warning",
    title: "Negative stock allowed: order placed with quantity > available",
    body: `BusinessLogicError: Order placed with quantity=5 but available_stock=2

    at validateOrder (lib/orders/validate.ts:34:11)

Validation reads stock THEN decrements; concurrent orders can both pass the check.
Fix: atomic UPDATE ... WHERE available_stock >= quantity.`,
    sourceIntegrations: ["sentry"],
  },
  {
    category: "business",
    severity: "critical",
    title: "Silent failure: Stripe webhook idempotency not enforced, duplicate charge",
    body: `Stripe webhook 'charge.succeeded' received twice for event evt_abc123
    at POST (app/api/webhooks/stripe/route.ts:45:14)

Idempotency key not persisted — second delivery re-ran the full handler, creating duplicate line items in our DB.`,
    sourceIntegrations: ["sentry"],
  },

  // Infra/deploy (3)
  {
    category: "infra",
    severity: "critical",
    title: "Production deploy failed: Next.js build exceeded 60s memory cap",
    body: `Deployment failed on Hetzner
  Error: Docker build exceeded 4GB memory limit during 'npm run build'
  Step: 10/15 next build

Commit: def5678 · Branch: main
Recent changes: added 3 heavy RSC boundaries + barrel imports`,
    sourceIntegrations: ["github"],
  },
  {
    category: "infra",
    severity: "warning",
    title: "Redis connection refused: 172.18.0.1:6379 (kamal accessory down)",
    body: `Error: connect ECONNREFUSED 172.18.0.1:6379
    at TCPConnectWrap.afterConnect (node:net:1624:16)

Redis accessory container is restarting. All rate limit + dedup paths falling back to Postgres (slower but functional).
Duration: 45s so far.`,
    sourceIntegrations: ["datadog"],
  },
  {
    category: "infra",
    severity: "critical",
    title: "Migration 0066 partially applied, leaving schema in inconsistent state",
    body: `Migration 0066_add_user_preferences partially applied:
  ✓ CREATE TABLE user_preferences
  ✗ ALTER TABLE users ADD COLUMN preferences_id failed: deadlock detected

Schema is now out of sync with code.`,
    sourceIntegrations: ["datadog"],
  },

  // Edge cases (3)
  {
    category: "edge",
    severity: "warning",
    title: "Unicode handling: emoji in username broke CSV export",
    body: `Error: Invalid UTF-8 byte sequence in CSV export
    at formatCSVRow (lib/exports/csv.ts:45:18)

Username: "José 🎉 Martínez" — the emoji byte encoding broke the naive string split on commas.`,
    sourceIntegrations: ["sentry"],
  },
  {
    category: "edge",
    severity: "warning",
    title: "Timezone bug: daily digest sent at 23:00 instead of 09:00 for UTC-14",
    body: `Logic error: cron job uses server UTC but user preference stored in local tz
    at scheduleDigest (lib/digest/schedule.ts:67:14)

User in Kiribati (UTC+14) configured digest for 09:00 local = 19:00 prev day UTC.
Scheduler fires at 09:00 UTC regardless.`,
    sourceIntegrations: ["sentry"],
  },
  {
    category: "edge",
    severity: "critical",
    title: "Memory leak: websocket connections not cleaned on client disconnect",
    body: `Node memory climbing: heap 1.2GB → 3.8GB over 6 hours

Open WebSocket connections: 847 (expected: ~50)
Client disconnect handler not unregistered from the alerts subscription map.
    at new AlertSubscription (lib/realtime/subscription.ts:23:14)`,
    sourceIntegrations: ["datadog"],
  },
];

// ── Main ────────────────────────────────────────────────────────────────────

interface Args {
  projectId?: string;
  count: number;
  dryRun: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const projectIdx = args.indexOf("--project");
  const countIdx = args.indexOf("--count");
  return {
    projectId: projectIdx >= 0 ? args[projectIdx + 1] : undefined,
    count: countIdx >= 0 ? parseInt(args[countIdx + 1], 10) : FIXTURES.length,
    dryRun: args.includes("--dry-run"),
  };
}

async function main() {
  const args = parseArgs();

  console.log(`🌱 InariWatch baseline seed`);
  console.log(`   fixtures: ${Math.min(args.count, FIXTURES.length)}`);
  console.log(`   mode: ${args.dryRun ? "DRY RUN (no writes)" : "LIVE"}`);
  console.log();

  // Resolve target project
  let projectId = args.projectId;
  if (!projectId) {
    const rows = await db
      .select({ id: schema.projects.id, name: schema.projects.name, userId: schema.projects.userId })
      .from(schema.projects)
      .limit(1);
    if (rows.length === 0) {
      console.error("No projects found. Pass --project <id> or create a project first.");
      process.exit(1);
    }
    projectId = rows[0].id;
    console.log(`Using project "${rows[0].name}" (${projectId})`);
  }

  const baselineRun = new Date().toISOString();
  const createdIds: string[] = [];
  const fixtures = FIXTURES.slice(0, args.count);

  console.log(`\nCreating ${fixtures.length} seed alerts (baselineRun=${baselineRun}):\n`);

  // Import autoAnalyzeAlert lazily — only if not dry-run.
  // We call the AI pipeline DIRECTLY (not via BullMQ) so we avoid side
  // effects from post-alert-created (outgoing webhooks, public status page
  // incidents, Slack/Telegram notifications). The pipeline still logs to
  // ai_usage_logs and creates the same InariLens rows we want to measure.
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

  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i];
    const label = `[${String(i + 1).padStart(2, "0")}/${fixtures.length}] ${f.category.padEnd(14)} ${f.severity.padEnd(8)}`;

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
          sourceIntegrations: f.sourceIntegrations,
          correlationData: {
            seed: true,
            baselineRun,
            category: f.category,
            fixtureIndex: i,
          },
        })
        .returning();

      createdIds.push(inserted.id);

      // Run the AI diagnosis pipeline directly. This hits gpt-4o-mini via
      // autoAnalyzeAlert → callAI → InariLens logger. No notifications,
      // no status page, no webhook dispatch.
      if (autoAnalyzeAlert) {
        try {
          await autoAnalyzeAlert(inserted);
          const ms = Date.now() - t0;
          console.log(`${label} ${inserted.id.slice(0, 8)}… ✓ analyzed (${ms}ms)`);
        } catch (err) {
          console.log(`${label} ${inserted.id.slice(0, 8)}… ⚠ analyze failed: ${err instanceof Error ? err.message : err}`);
        }
      } else {
        console.log(`${label} ${inserted.id.slice(0, 8)}… ⚠ inserted, NOT analyzed`);
      }

      // Small delay between fixtures — keeps the AI rate limit + DB load
      // reasonable and makes the output readable.
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.error(`${label} FAILED:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`\n✅ Done. Created ${createdIds.length} seed alerts.\n`);
  console.log(`Watch /admin/ai over the next 5-10 minutes — sessions + AI calls should flow in.`);
  console.log(`\nbaselineRun tag: ${baselineRun}`);
  console.log(`\nTo clean up:`);
  console.log(`   npx tsx scripts/cleanup-baseline-seed.ts`);
  console.log(`Or just this run:`);
  console.log(`   npx tsx scripts/cleanup-baseline-seed.ts --baseline-run "${baselineRun}"`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
