"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
  db,
  projects,
  projectIntegrations,
  organizations,
  organizationMembers,
} from "@/lib/db";
import { encryptConfig, encrypt } from "@/lib/crypto";
import { generateWebhookSecret } from "@/lib/webhooks/shared";
import { logAudit } from "@/lib/audit";

export type CaptureActionResult = { ok: true } | { ok: false; error: string };

async function authorizeProject(
  projectId: string,
): Promise<{ userId: string; ok: true } | { ok: false; error: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return { ok: false, error: "You need to be signed in." };

  const [project] = await db
    .select({
      userId: projects.userId,
      organizationId: projects.organizationId,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return { ok: false, error: "Project not found." };

  if (project.userId === userId) return { userId, ok: true };

  if (project.organizationId) {
    const [orgRow] = await db
      .select({ ownerId: organizations.ownerId })
      .from(organizations)
      .where(eq(organizations.id, project.organizationId))
      .limit(1);
    if (orgRow?.ownerId === userId) return { userId, ok: true };

    const [member] = await db
      .select({ role: organizationMembers.role })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, project.organizationId),
          eq(organizationMembers.userId, userId),
        ),
      )
      .limit(1);
    if (member && (member.role === "owner" || member.role === "admin")) {
      return { userId, ok: true };
    }
  }

  return { ok: false, error: "You're not the owner of this project." };
}

export async function enableCapture(projectId: string): Promise<CaptureActionResult> {
  const auth = await authorizeProject(projectId);
  if (!auth.ok) return auth;

  const [existing] = await db
    .select({ id: projectIntegrations.id })
    .from(projectIntegrations)
    .where(
      and(
        eq(projectIntegrations.projectId, projectId),
        eq(projectIntegrations.service, "capture"),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(projectIntegrations)
      .set({ isActive: true, errorCount: 0 })
      .where(eq(projectIntegrations.id, existing.id));
  } else {
    await db.insert(projectIntegrations).values({
      projectId,
      service: "capture",
      configEncrypted: encryptConfig({}),
      webhookSecret: encrypt(generateWebhookSecret()),
      isActive: true,
    });
  }

  logAudit({
    userId: auth.userId,
    action: "integration.connect",
    resource: "integration",
    metadata: { service: "capture" },
  });

  revalidatePath(`/projects`);
  return { ok: true };
}

export async function disableCapture(projectId: string): Promise<CaptureActionResult> {
  const auth = await authorizeProject(projectId);
  if (!auth.ok) return auth;

  const [existing] = await db
    .select({ id: projectIntegrations.id })
    .from(projectIntegrations)
    .where(
      and(
        eq(projectIntegrations.projectId, projectId),
        eq(projectIntegrations.service, "capture"),
      ),
    )
    .limit(1);
  if (!existing) return { ok: true };

  await db.delete(projectIntegrations).where(eq(projectIntegrations.id, existing.id));

  logAudit({
    userId: auth.userId,
    action: "integration.disconnect",
    resource: "integration",
    resourceId: existing.id,
    metadata: { service: "capture" },
  });

  revalidatePath(`/projects`);
  return { ok: true };
}
