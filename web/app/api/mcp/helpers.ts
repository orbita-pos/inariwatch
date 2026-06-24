import { db, projects, organizationMembers } from "@/lib/db";
import { eq, and, or } from "drizzle-orm";

/**
 * Check if a user can access a project.
 * Access is granted if:
 *   1. The user is the project owner (projects.userId)
 *   2. The user is a member of the project's organization (organizationMembers)
 */
export async function userCanAccessProject(
  userId: string,
  projectId: string
): Promise<boolean> {
  const [project] = await db
    .select({ id: projects.id, userId: projects.userId, organizationId: projects.organizationId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) return false;

  // Owner always has access
  if (project.userId === userId) return true;

  // Check org membership
  if (project.organizationId) {
    const [member] = await db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, project.organizationId),
          eq(organizationMembers.userId, userId)
        )
      )
      .limit(1);

    if (member) return true;
  }

  return false;
}

/**
 * Get all project IDs accessible to a user (owned + org member).
 */
export async function getUserProjectIds(userId: string): Promise<string[]> {
  // Projects the user owns
  const owned = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.userId, userId));

  const ownedIds = new Set(owned.map((p) => p.id));

  // Projects from orgs the user belongs to
  const orgMemberships = await db
    .select({ organizationId: organizationMembers.organizationId })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, userId));

  if (orgMemberships.length > 0) {
    for (const m of orgMemberships) {
      const orgProjects = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.organizationId, m.organizationId));

      for (const p of orgProjects) {
        ownedIds.add(p.id);
      }
    }
  }

  return Array.from(ownedIds);
}
