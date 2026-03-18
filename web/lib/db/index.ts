import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq, or, inArray, and, isNull } from "drizzle-orm";
import * as schema from "./schema";

const sql = neon(process.env.DATABASE_URL!);
export const db = drizzle(sql, { schema });

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
 * - orgId = uuid → org workspace (only projects belonging to that org)
 */
export async function getWorkspaceProjectIds(userId: string, orgId: string | null): Promise<string[]> {
  if (orgId === null) {
    // Personal: projects owned by user with no organizationId
    const rows = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(and(eq(schema.projects.userId, userId), isNull(schema.projects.organizationId)));
    return rows.map((r) => r.id);
  } else {
    // Org workspace: all projects in this org
    const rows = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.organizationId, orgId));
    return rows.map((r) => r.id);
  }
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

export const PLAN_LIMITS: Record<string, { maxProjects: number; maxIntegrations: number; pollIntervalLabel: string }> = {
  free: { maxProjects: 1, maxIntegrations: 2, pollIntervalLabel: "Every 30 min" },
  pro: { maxProjects: 10, maxIntegrations: 20, pollIntervalLabel: "Every 5 min" },
};

// ── Severity ordering ────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2 };

export function severityMeetsMinimum(alertSeverity: string, minSeverity: string): boolean {
  return (SEVERITY_ORDER[alertSeverity] ?? 2) <= (SEVERITY_ORDER[minSeverity] ?? 2);
}
