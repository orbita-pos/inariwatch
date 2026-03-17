"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  db,
  projects,
  projectMembers,
  projectInvites,
  users,
  maintenanceWindows,
  escalationRules,
  notificationChannels,
} from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { randomBytes } from "crypto";

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

// ── Actions ──────────────────────────────────────────────────────────────────

export async function inviteMember(
  projectId: string,
  email: string,
  role: string
): Promise<{ error?: string }> {
  try {
    const result = await requireAdmin(projectId);
    if ("error" in result) return { error: result.error };

    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail || !trimmedEmail.includes("@")) {
      return { error: "Please enter a valid email address." };
    }

    if (role !== "admin" && role !== "viewer") {
      return { error: "Role must be admin or viewer." };
    }

    // Check if project exists
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) return { error: "Project not found." };

    // Check if the email belongs to the project owner
    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.id, project.userId))
      .limit(1);
    if (owner && owner.email === trimmedEmail) {
      return { error: "This user is already the project owner." };
    }

    // Check if user is already a member
    const [existingUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, trimmedEmail))
      .limit(1);

    if (existingUser) {
      const [existingMember] = await db
        .select()
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.userId, existingUser.id)
          )
        )
        .limit(1);
      if (existingMember) {
        return { error: "This user is already a member of this project." };
      }
    }

    // Check if there's already a pending invite for this email
    const [existingInvite] = await db
      .select()
      .from(projectInvites)
      .where(
        and(
          eq(projectInvites.projectId, projectId),
          eq(projectInvites.email, trimmedEmail)
        )
      )
      .limit(1);
    if (existingInvite) {
      return { error: "An invite has already been sent to this email." };
    }

    // Generate invite token
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await db.insert(projectInvites).values({
      projectId,
      email: trimmedEmail,
      role: role as "admin" | "viewer",
      invitedBy: result.userId,
      token,
      expiresAt,
    });

    revalidatePath(`/projects/${project.slug}`);
    return {};
  } catch {
    return { error: "Failed to send invite. Please try again." };
  }
}

export async function removeMember(
  projectId: string,
  memberId: string
): Promise<{ error?: string }> {
  try {
    const result = await requireAdmin(projectId);
    if ("error" in result) return { error: result.error };

    // Verify the member exists and belongs to this project
    const [member] = await db
      .select()
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.id, memberId),
          eq(projectMembers.projectId, projectId)
        )
      )
      .limit(1);
    if (!member) return { error: "Member not found." };

    await db.delete(projectMembers).where(eq(projectMembers.id, memberId));

    // Get project slug for revalidation
    const [project] = await db
      .select({ slug: projects.slug })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (project) revalidatePath(`/projects/${project.slug}`);

    return {};
  } catch {
    return { error: "Failed to remove member. Please try again." };
  }
}

export async function updateMemberRole(
  projectId: string,
  memberId: string,
  role: string
): Promise<{ error?: string }> {
  try {
    const result = await requireAdmin(projectId);
    if ("error" in result) return { error: result.error };

    if (role !== "admin" && role !== "viewer") {
      return { error: "Role must be admin or viewer." };
    }

    // Verify the member exists and belongs to this project
    const [member] = await db
      .select()
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.id, memberId),
          eq(projectMembers.projectId, projectId)
        )
      )
      .limit(1);
    if (!member) return { error: "Member not found." };

    await db
      .update(projectMembers)
      .set({ role: role as "admin" | "viewer" })
      .where(eq(projectMembers.id, memberId));

    // Get project slug for revalidation
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

export async function cancelInvite(
  projectId: string,
  inviteId: string
): Promise<{ error?: string }> {
  try {
    const result = await requireAdmin(projectId);
    if ("error" in result) return { error: result.error };

    const [invite] = await db
      .select()
      .from(projectInvites)
      .where(
        and(
          eq(projectInvites.id, inviteId),
          eq(projectInvites.projectId, projectId)
        )
      )
      .limit(1);
    if (!invite) return { error: "Invite not found." };

    await db.delete(projectInvites).where(eq(projectInvites.id, inviteId));

    const [project] = await db
      .select({ slug: projects.slug })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (project) revalidatePath(`/projects/${project.slug}`);

    return {};
  } catch {
    return { error: "Failed to cancel invite. Please try again." };
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
  channelId: string,
  delaySec: number,
  minSeverity: string
): Promise<{ error?: string }> {
  try {
    const result = await requireAdmin(projectId);
    if ("error" in result) return { error: result.error };

    if (!channelId) return { error: "Notification channel is required." };

    if (!["critical", "warning", "info"].includes(minSeverity)) {
      return { error: "Invalid severity level." };
    }

    if (delaySec < 60) {
      return { error: "Delay must be at least 60 seconds." };
    }

    // Verify the channel belongs to the user
    const [channel] = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, channelId))
      .limit(1);
    if (!channel || channel.userId !== result.userId) {
      return { error: "Notification channel not found." };
    }

    await db.insert(escalationRules).values({
      projectId,
      channelId,
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
