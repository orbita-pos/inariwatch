import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq, or } from "drizzle-orm";
import * as schema from "./schema";

const sql = neon(process.env.DATABASE_URL!);
export const db = drizzle(sql, { schema });

export * from "./schema";

/**
 * Returns all project IDs where the user is the owner OR an accepted member.
 */
export async function getUserProjectIds(userId: string): Promise<string[]> {
  // Projects owned by the user
  const ownedProjects = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.userId, userId));

  // Projects where user is an accepted member
  const memberProjects = await db
    .select({ projectId: schema.projectMembers.projectId })
    .from(schema.projectMembers)
    .where(eq(schema.projectMembers.userId, userId));

  const ids = new Set<string>();
  for (const p of ownedProjects) ids.add(p.id);
  for (const p of memberProjects) ids.add(p.projectId);

  return Array.from(ids);
}

// ── Plan limits ──────────────────────────────────────────────────────────────

export const PLAN_LIMITS: Record<string, { maxProjects: number; maxIntegrations: number; pollIntervalLabel: string }> = {
  free: { maxProjects: 2, maxIntegrations: 3, pollIntervalLabel: "Every 30 min" },
  pro:  { maxProjects: 10, maxIntegrations: 20, pollIntervalLabel: "Every 5 min" },
  team: { maxProjects: 50, maxIntegrations: 100, pollIntervalLabel: "Every 5 min" },
};

// ── Severity ordering ────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2 };

export function severityMeetsMinimum(alertSeverity: string, minSeverity: string): boolean {
  return (SEVERITY_ORDER[alertSeverity] ?? 2) <= (SEVERITY_ORDER[minSeverity] ?? 2);
}
