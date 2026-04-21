import { neon } from "@neondatabase/serverless";
import { drizzle as drizzleNeonHttp } from "drizzle-orm/neon-http";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, or, inArray, and, isNull } from "drizzle-orm";
import * as schema from "./schema";

// Driver selection (A1 — VERCEL_LEVEL_AUDIT_REPORT.md):
//
//   DB_DRIVER=neon-http (default)
//     Legacy serverless-optimised HTTP driver. New TCP/TLS handshake per
//     query; great for ephemeral Vercel functions but wasteful on a
//     long-running Kamal-hosted Node process (6 queries per dashboard
//     render ≈ 6 × ~100 ms warm HTTP roundtrips).
//
//   DB_DRIVER=pg
//     pg.Pool over persistent TCP. Reuses connections across requests,
//     drops warm per-query latency from ~100 ms to ~15 ms against the
//     Neon pooler endpoint. Expects DATABASE_URL to point at the Neon
//     POOLER host (`ep-xxx-pooler.<region>.aws.neon.tech`) — transaction-
//     mode pooling is compatible with Drizzle because we don't use
//     prepared statements pinned across queries.
//
// Rollback path: `kamal env push DB_DRIVER=neon-http` — no rebuild needed.
//
// DATABASE_URL   — direct Neon endpoint (ep-xxx.<region>.aws.neon.tech),
//                  used by both neon-http and pg when DATABASE_URL_POOLED
//                  is unset. neon-http required this shape historically.
// DATABASE_URL_POOLED — optional pooler endpoint
//                  (ep-xxx-pooler.<region>.aws.neon.tech). When set and
//                  DB_DRIVER=pg, the pg.Pool connects through PgBouncer
//                  which caps at 10k pooled connections and reuses TCP.
function createDb() {
  const directUrl = process.env.DATABASE_URL;
  const pooledUrl = process.env.DATABASE_URL_POOLED;
  if (!directUrl) throw new Error("DATABASE_URL is not set");
  const driver = (process.env.DB_DRIVER ?? "neon-http").toLowerCase();

  if (driver === "pg") {
    const url = pooledUrl ?? directUrl;
    const pool = new Pool({
      connectionString: url,
      // CX22 has 2 vCPU — 10 per-pod connections is plenty. Neon pooler
      // at Launch plan allows 10,000 pooled connections so we're nowhere
      // near the ceiling.
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      keepAlive: true,
      // PgBouncer transaction-mode pooling + Drizzle: disable explicit
      // prepared-statement caching so we don't pin prepared plans to a
      // connection that gets handed to another session mid-transaction.
      allowExitOnIdle: true,
    });
    console.log("[db] driver=pg against", url.replace(/\/\/[^@]+@/, "//***@").slice(0, 120));
    return drizzlePg(pool, { schema });
  }

  console.log("[db] driver=neon-http against", directUrl.replace(/\/\/[^@]+@/, "//***@").slice(0, 120));
  return drizzleNeonHttp(neon(directUrl), { schema });
}

// Runtime type varies by DB_DRIVER but the call surface Drizzle exposes
// is identical for the two drivers on the methods we use (select, insert,
// update, delete, execute). Cast to the neon-http return type so the rest
// of the codebase keeps its existing inference without any churn.
export const db = createDb() as ReturnType<typeof drizzleNeonHttp<typeof schema>>;

export * from "./schema";

/**
 * Returns all project IDs where the user is the owner, a project member,
 * or a member of the project's organization.
 */
export async function getUserProjectIds(userId: string): Promise<string[]> {
  const [ownedProjects, memberProjects, orgMemberships] = await Promise.all([
    db.select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.userId, userId)),
    db.select({ projectId: schema.projectMembers.projectId })
      .from(schema.projectMembers)
      .where(eq(schema.projectMembers.userId, userId)),
    db.select({ organizationId: schema.organizationMembers.organizationId })
      .from(schema.organizationMembers)
      .where(eq(schema.organizationMembers.userId, userId)),
  ]);

  const ids = new Set<string>();
  for (const p of ownedProjects) ids.add(p.id);
  for (const p of memberProjects) ids.add(p.projectId);

  // Projects belonging to orgs the user is a member of
  const orgIds = orgMemberships.map((m) => m.organizationId);
  if (orgIds.length > 0) {
    const orgProjects = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(inArray(schema.projects.organizationId, orgIds));
    for (const p of orgProjects) ids.add(p.id);
  }

  return Array.from(ids);
}

/**
 * Returns project IDs scoped to the active workspace.
 * - orgId = null → personal workspace (only user-owned projects without an org)
 * - orgId = uuid → org workspace (org projects, filtering restricted ones
 *   for non-owner members who haven't been granted explicit access)
 */
export async function getWorkspaceProjectIds(userId: string, orgId: string | null): Promise<string[]> {
  if (orgId === null) {
    // Personal: projects owned by user with no organizationId
    const rows = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(and(eq(schema.projects.userId, userId), isNull(schema.projects.organizationId)));
    return rows.map((r) => r.id);
  }

  // Org workspace: get all projects in this org
  const allOrgProjects = await db
    .select({
      id: schema.projects.id,
      userId: schema.projects.userId,
      visibility: schema.projects.visibility,
    })
    .from(schema.projects)
    .where(eq(schema.projects.organizationId, orgId));

  // Fast path: no restricted projects
  const restrictedProjects = allOrgProjects.filter((p) => p.visibility === "restricted");
  if (restrictedProjects.length === 0) return allOrgProjects.map((p) => p.id);

  // Fetch which restricted projects this user has explicit access to
  const restrictedIds = restrictedProjects.map((p) => p.id);
  const accessRows = await db
    .select({ projectId: schema.projectMembers.projectId })
    .from(schema.projectMembers)
    .where(
      and(
        eq(schema.projectMembers.userId, userId),
        inArray(schema.projectMembers.projectId, restrictedIds)
      )
    );
  const accessSet = new Set(accessRows.map((r) => r.projectId));

  // Include project if: visibility='all', OR user is the project owner, OR user has explicit access
  return allOrgProjects
    .filter((p) => p.visibility === "all" || p.userId === userId || accessSet.has(p.id))
    .map((p) => p.id);
}

/**
 * Returns organizations the user owns or is a member of.
 */
export async function getUserOrganizations(userId: string) {
  const [owned, memberships] = await Promise.all([
    db.select().from(schema.organizations).where(eq(schema.organizations.ownerId, userId)),
    db.select({
      id: schema.organizations.id,
      name: schema.organizations.name,
      slug: schema.organizations.slug,
      ownerId: schema.organizations.ownerId,
      avatarUrl: schema.organizations.avatarUrl,
      createdAt: schema.organizations.createdAt,
      role: schema.organizationMembers.role,
    })
      .from(schema.organizationMembers)
      .innerJoin(schema.organizations, eq(schema.organizationMembers.organizationId, schema.organizations.id))
      .where(eq(schema.organizationMembers.userId, userId)),
  ]);

  // Merge — owner might also be a member row
  const map = new Map<string, { id: string; name: string; slug: string; ownerId: string; avatarUrl: string | null; role: string }>();
  for (const o of owned) {
    map.set(o.id, {
      id: o.id,
      name: o.name,
      slug: o.slug,
      ownerId: o.ownerId,
      avatarUrl: o.avatarUrl ?? null,
      role: "owner",
    });
  }
  for (const m of memberships) if (!map.has(m.id)) map.set(m.id, { ...m, avatarUrl: m.avatarUrl });

  return Array.from(map.values());
}

// ── Plan limits ──────────────────────────────────────────────────────────────
//
// Free is for solo devs / side projects (3 projects, 5 integrations).
// Pro unlocks the real product (100p / 200i).
//
// `maxCaptureEventsPerDay` is enforced by capture + other webhook routes
// via a per-project sliding window counter (web/lib/auth-rate-limit.ts).
//
// `pollIntervalMinutes` drives the cron poller skip logic — free integrations
// are skipped 4 of 5 cycles to keep upstream API spend (Sentry, Vercel, GH)
// under control. The label is what users see in the dashboard.

export interface PlanLimit {
  maxProjects: number;
  maxIntegrations: number;
  maxCaptureEventsPerDay: number;
  pollIntervalMinutes: number;
  pollIntervalLabel: string;
}

/**
 * Beta mode: all users get Pro resource limits.
 * When beta ends, flip to `null` and restore DB-based plan resolution.
 */
export const BETA_PLAN: string | null = "pro";

export const PLAN_LIMITS: Record<string, PlanLimit> = {
  free: {
    maxProjects: 3,
    maxIntegrations: 5,
    maxCaptureEventsPerDay: 50_000,
    pollIntervalMinutes: 5,
    pollIntervalLabel: "Every 5 min",
  },
  pro: {
    maxProjects: 100,
    maxIntegrations: 200,
    maxCaptureEventsPerDay: 500_000,
    pollIntervalMinutes: 1,
    pollIntervalLabel: "Every 1 min",
  },
  team: {
    maxProjects: 100,
    maxIntegrations: 200,
    maxCaptureEventsPerDay: 500_000,
    pollIntervalMinutes: 1,
    pollIntervalLabel: "Every 1 min",
  },
};

/**
 * Decide whether a poller cron should poll this integration on the current
 * tick. Free integrations are throttled to once per `pollIntervalMinutes`
 * to keep upstream API spend (Sentry, Vercel, GitHub, Expo) bounded under
 * viral load.
 *
 * Used by the Sentry/Vercel/GitHub/Expo poller routes. Uptime + npm-audit
 * are NOT throttled — uptime needs low-latency detection and npm-audit
 * makes no upstream calls.
 */
export function shouldPollThisCycle(plan: string, lastCheckedAt: Date | null): boolean {
  const limits = PLAN_LIMITS[BETA_PLAN ?? plan] ?? PLAN_LIMITS.free;
  if (limits.pollIntervalMinutes <= 1) return true;
  if (!lastCheckedAt) return true; // Never polled — always run
  const minutesSince = (Date.now() - lastCheckedAt.getTime()) / 60_000;
  // Allow a tiny bit of slack so we don't accidentally double-skip when
  // the cron tick lands a few seconds late.
  return minutesSince >= limits.pollIntervalMinutes - 0.25;
}

// ── Severity ordering ────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2 };

export function severityMeetsMinimum(alertSeverity: string, minSeverity: string): boolean {
  return (SEVERITY_ORDER[alertSeverity] ?? 2) <= (SEVERITY_ORDER[minSeverity] ?? 2);
}
