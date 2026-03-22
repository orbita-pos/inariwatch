"use server";

import { db, organizations, organizationMembers, users } from "@/lib/db";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";

async function getCallerId(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  return (session?.user as { id?: string })?.id ?? null;
}

export async function updateWorkspaceName(
  orgId: string,
  name: string
): Promise<{ error?: string }> {
  const callerId = await getCallerId();
  if (!callerId) return { error: "Not authenticated" };

  // Verify caller is owner or admin
  const [membership] = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, orgId),
        eq(organizationMembers.userId, callerId)
      )
    )
    .limit(1);

  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    return { error: "You must be an owner or admin to update workspace name" };
  }

  const trimmed = name?.trim() ?? "";
  if (trimmed.length < 2 || trimmed.length > 40) {
    return { error: "Name must be between 2 and 40 characters" };
  }

  await db
    .update(organizations)
    .set({ name: trimmed })
    .where(eq(organizations.id, orgId));

  revalidatePath("/workspace/settings");
  return {};
}

export async function removeMember(
  orgId: string,
  targetUserId: string
): Promise<{ error?: string }> {
  const callerId = await getCallerId();
  if (!callerId) return { error: "Not authenticated" };

  // Verify caller is owner or admin
  const [callerMembership] = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, orgId),
        eq(organizationMembers.userId, callerId)
      )
    )
    .limit(1);

  if (!callerMembership || (callerMembership.role !== "owner" && callerMembership.role !== "admin")) {
    return { error: "You must be an owner or admin to remove members" };
  }

  // Get the org to check ownerId
  const [org] = await db
    .select({ ownerId: organizations.ownerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) return { error: "Workspace not found" };

  // Prevent removing the owner
  if (targetUserId === org.ownerId) {
    return { error: "Cannot remove the workspace owner" };
  }

  await db
    .delete(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, orgId),
        eq(organizationMembers.userId, targetUserId)
      )
    );

  revalidatePath("/workspace/settings");
  return {};
}

export async function updateMemberRole(
  orgId: string,
  targetUserId: string,
  role: "admin" | "member"
): Promise<{ error?: string }> {
  const callerId = await getCallerId();
  if (!callerId) return { error: "Not authenticated" };

  // Verify caller is owner
  const [org] = await db
    .select({ ownerId: organizations.ownerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) return { error: "Workspace not found" };
  if (org.ownerId !== callerId) return { error: "Only the owner can change member roles" };

  // Prevent changing owner's own role
  if (targetUserId === callerId) {
    return { error: "Cannot change your own role as owner" };
  }

  // Prevent changing the owner's role
  if (targetUserId === org.ownerId) {
    return { error: "Cannot change the owner's role" };
  }

  await db
    .update(organizationMembers)
    .set({ role })
    .where(
      and(
        eq(organizationMembers.organizationId, orgId),
        eq(organizationMembers.userId, targetUserId)
      )
    );

  revalidatePath("/workspace/settings");
  return {};
}

export async function leaveWorkspace(
  orgId: string
): Promise<{ error?: string }> {
  const callerId = await getCallerId();
  if (!callerId) return { error: "Not authenticated" };

  // Get org to check ownerId
  const [org] = await db
    .select({ ownerId: organizations.ownerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) return { error: "Workspace not found" };

  // Owner must delete the workspace, not leave it
  if (org.ownerId === callerId) {
    return { error: "As the owner, you must delete the workspace instead of leaving" };
  }

  await db
    .delete(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, orgId),
        eq(organizationMembers.userId, callerId)
      )
    );

  // Clear active org
  await db
    .update(users)
    .set({ activeOrgId: null })
    .where(eq(users.id, callerId));

  revalidatePath("/dashboard");
  return {};
}

export async function deleteWorkspace(
  orgId: string
): Promise<{ error?: string }> {
  const callerId = await getCallerId();
  if (!callerId) return { error: "Not authenticated" };

  // Get org to check ownerId
  const [org] = await db
    .select({ ownerId: organizations.ownerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) return { error: "Workspace not found" };
  if (org.ownerId !== callerId) return { error: "Only the owner can delete the workspace" };

  await db
    .delete(organizations)
    .where(eq(organizations.id, orgId));

  revalidatePath("/dashboard");
  return {};
}
