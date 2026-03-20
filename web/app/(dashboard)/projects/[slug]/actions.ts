"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  db,
  projects,
  projectMembers,
  users,
  organizations,
  organizationMembers,
  maintenanceWindows,
  escalationRules,
  notificationChannels,
} from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function requireAdmin(
  projectId: string
): Promise<{ userId: string } | { error: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated." };

  // Owner is always admin
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (project) return { userId };

  // Check if user is an admin member
  const [member] = await db
    .select()
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
        eq(projectMembers.role, "admin")
      )
    )
    .limit(1);
  if (member) return { userId };

  return { error: "You must be a project admin to perform this action." };
}

// ── Project Access Control ───────────────────────────────────────────────────

export async function setProjectVisibility(
  projectId: string,
  visibility: string
): Promise<{ error?: string }> {
  try {
    const result = await requireAdmin(projectId);
    if ("error" in result) return { error: result.error };

    if (visibility !== "all" && visibility !== "restricted") {
      return { error: "Visibility must be 'all' or 'restricted'." };
    }

    await db
      .update(projects)
      .set({ visibility })
      .where(eq(projects.id, projectId));

    // Get project slug for revalidation
    const [project] = await db
      .select({ slug: projects.slug })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (project) revalidatePath(`/projects/${project.slug}`);

    return {};
  } catch {
    return { error: "Failed to update visibility. Please try again." };
  }
}

export async function addProjectAccess(
  projectId: string,
  userId: string
): Promise<{ error?: string }> {
  try {
    const result = await requireAdmin(projectId);
    if ("error" in result) return { error: result.error };

    // Check if user exists
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return { error: "User not found." };

    // Verify project exists and belongs to an org
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) return { error: "Project not found." };
    if (!project.organizationId) return { error: "Access control is only for workspace projects." };

    // Verify the user is a member of the org
    const [orgMember] = await db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, project.organizationId),
          eq(organizationMembers.userId, userId)
        )
      )
      .limit(1);
    if (!orgMember) return { error: "User must be a workspace member first." };

    // Check if already has access
    const [existing] = await db
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .where(
        and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId))
      )
      .limit(1);
    if (existing) return { error: "User already has access to this project." };

    await db.insert(projectMembers).values({
      projectId,
      userId,
      role: "viewer",
    });

    revalidatePath(`/projects/${project.slug}`);
    return {};
  } catch {
    return { error: "Failed to grant access. Please try again." };
  }
}

export async function removeProjectAccess(
  projectId: string,
  userId: string
): Promise<{ error?: string }> {
  try {
    const result = await requireAdmin(projectId);
    if ("error" in result) return { error: result.error };

    // Don't allow removing the project owner
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) return { error: "Project not found." };
    if (project.userId === userId) return { error: "Cannot remove the project owner." };

    await db
      .delete(projectMembers)
      .where(
        and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId))
      );

    revalidatePath(`/projects/${project.slug}`);
    return {};
  } catch {
    return { error: "Failed to revoke access. Please try again." };
  }
}

export async function updateProjectMemberRole(
  projectId: string,
  userId: string,
  role: string
): Promise<{ error?: string }> {
  try {
    const result = await requireAdmin(projectId);
    if ("error" in result) return { error: result.error };

    if (role !== "admin" && role !== "viewer") {
      return { error: "Role must be admin or viewer." };
    }

    const [member] = await db
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .where(
        and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId))
      )
      .limit(1);
    if (!member) return { error: "Member not found." };

    await db
      .update(projectMembers)
      .set({ role: role as "admin" | "viewer" })
      .where(eq(projectMembers.id, member.id));

    const [project] = await db
      .select({ slug: projects.slug })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (project) revalidatePath(`/projects/${project.slug}`);

    return {};
  } catch {
    return { error: "Failed to update role. Please try again." };
  }
}

// ── Maintenance Windows ───────────────────────────────────────────────────────

export async function createMaintenanceWindow(
  projectId: string,
  title: string,
  startsAt: string,
  endsAt: string
): Promise<{ error?: string }> {
  try {
    const result = await requireAdmin(projectId);
    if ("error" in result) return { error: result.error };

    const trimmedTitle = title.trim();
    if (!trimmedTitle) return { error: "Title is required." };

    const start = new Date(startsAt);
    const end = new Date(endsAt);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return { error: "Invalid date format." };
    }
    if (end <= start) {
      return { error: "End time must be after start time." };
    }

    await db.insert(maintenanceWindows).values({
      projectId,
      title: trimmedTitle,
      startsAt: start,
      endsAt: end,
      createdBy: result.userId,
    });

    const [project] = await db
      .select({ slug: projects.slug })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (project) revalidatePath(`/projects/${project.slug}`);

    return {};
  } catch {
    return { error: "Failed to create maintenance window. Please try again." };
  }
}

export async function deleteMaintenanceWindow(
  projectId: string,
  windowId: string
): Promise<{ error?: string }> {
  try {
    const result = await requireAdmin(projectId);
    if ("error" in result) return { error: result.error };

    const [window] = await db
      .select()
      .from(maintenanceWindows)
      .where(
        and(
          eq(maintenanceWindows.id, windowId),
          eq(maintenanceWindows.projectId, projectId)
        )
      )
      .limit(1);
    if (!window) return { error: "Maintenance window not found." };

    await db
      .delete(maintenanceWindows)
      .where(eq(maintenanceWindows.id, windowId));

    const [project] = await db
      .select({ slug: projects.slug })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (project) revalidatePath(`/projects/${project.slug}`);

    return {};
  } catch {
    return { error: "Failed to delete maintenance window. Please try again." };
  }
}

// ── Escalation Rules ─────────────────────────────────────────────────────────

export async function createEscalationRule(
  projectId: string,
  targetType: string,
  channelId: string | null,
  delaySec: number,
  minSeverity: string
): Promise<{ error?: string }> {
  try {
    const result = await requireAdmin(projectId);
    if ("error" in result) return { error: result.error };

    if (!targetType) return { error: "Target type is required." };
    if (targetType === "channel" && !channelId) {
      return { error: "Notification channel is required." };
    }

    if (!["critical", "warning", "info"].includes(minSeverity)) {
      return { error: "Invalid severity level." };
    }

    if (delaySec < 60 && delaySec !== 0) {
      return { error: "Delay must be at least 60 seconds (or 0)." };
    }

    // Verify the channel belongs to the user if target is a channel
    if (targetType === "channel" && channelId) {
      const [channel] = await db
        .select()
        .from(notificationChannels)
        .where(eq(notificationChannels.id, channelId))
        .limit(1);
      if (!channel || channel.userId !== result.userId) {
        return { error: "Notification channel not found." };
      }
    }

    await db.insert(escalationRules).values({
      projectId,
      targetType,
      channelId: targetType === "channel" ? channelId : null,
      delaySec,
      minSeverity,
    });

    const [project] = await db
      .select({ slug: projects.slug })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (project) revalidatePath(`/projects/${project.slug}`);

    return {};
  } catch {
    return { error: "Failed to create escalation rule. Please try again." };
  }
}

export async function deleteEscalationRule(
  projectId: string,
  ruleId: string
): Promise<{ error?: string }> {
  try {
    const result = await requireAdmin(projectId);
    if ("error" in result) return { error: result.error };

    const [rule] = await db
      .select()
      .from(escalationRules)
      .where(
        and(
          eq(escalationRules.id, ruleId),
          eq(escalationRules.projectId, projectId)
        )
      )
      .limit(1);
    if (!rule) return { error: "Escalation rule not found." };

    await db.delete(escalationRules).where(eq(escalationRules.id, ruleId));

    const [project] = await db
      .select({ slug: projects.slug })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (project) revalidatePath(`/projects/${project.slug}`);

    return {};
  } catch {
    return { error: "Failed to delete escalation rule. Please try again." };
  }
}

export async function toggleEscalationRule(
  projectId: string,
  ruleId: string,
  isActive: boolean
): Promise<{ error?: string }> {
  try {
    const result = await requireAdmin(projectId);
    if ("error" in result) return { error: result.error };

    const [rule] = await db
      .select()
      .from(escalationRules)
      .where(
        and(
          eq(escalationRules.id, ruleId),
          eq(escalationRules.projectId, projectId)
        )
      )
      .limit(1);
    if (!rule) return { error: "Escalation rule not found." };

    await db
      .update(escalationRules)
      .set({ isActive })
      .where(eq(escalationRules.id, ruleId));

    const [project] = await db
      .select({ slug: projects.slug })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (project) revalidatePath(`/projects/${project.slug}`);

    return {};
  } catch {
    return { error: "Failed to update escalation rule. Please try again." };
  }
}
