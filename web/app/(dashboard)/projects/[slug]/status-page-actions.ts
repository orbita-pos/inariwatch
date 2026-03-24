"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, projects, statusPages, type StatusPageConfig } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";

async function verifyProjectOwner(projectId: string): Promise<boolean> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return false;

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);

  return !!project;
}

export async function createStatusPage(
  projectId: string,
  title: string,
  slug: string
): Promise<{ error?: string }> {
  if (!(await verifyProjectOwner(projectId))) return { error: "Unauthorized" };

  // Check slug uniqueness
  const [existing] = await db
    .select({ id: statusPages.id })
    .from(statusPages)
    .where(eq(statusPages.slug, slug))
    .limit(1);

  if (existing) return { error: "Slug already taken." };

  await db.insert(statusPages).values({
    projectId,
    slug,
    title,
    isPublic: true,
  });

  revalidatePath(`/projects`);
  return {};
}

export async function toggleStatusPage(
  statusPageId: string,
  isPublic: boolean
): Promise<void> {
  const [page] = await db
    .select({ projectId: statusPages.projectId })
    .from(statusPages)
    .where(eq(statusPages.id, statusPageId))
    .limit(1);

  if (!page) return;
  if (!(await verifyProjectOwner(page.projectId))) return;

  await db
    .update(statusPages)
    .set({ isPublic })
    .where(eq(statusPages.id, statusPageId));

  revalidatePath(`/projects`);
}

export async function updateStatusPageConfig(
  statusPageId: string,
  updates: Partial<StatusPageConfig>
): Promise<void> {
  const [page] = await db
    .select({ projectId: statusPages.projectId, config: statusPages.config })
    .from(statusPages)
    .where(eq(statusPages.id, statusPageId))
    .limit(1);

  if (!page) return;
  if (!(await verifyProjectOwner(page.projectId))) return;

  const currentConfig = (page.config ?? {}) as StatusPageConfig;
  const newConfig = { ...currentConfig, ...updates };

  await db
    .update(statusPages)
    .set({ config: newConfig })
    .where(eq(statusPages.id, statusPageId));

  revalidatePath(`/projects`);
}

export async function deleteStatusPage(statusPageId: string): Promise<void> {
  const [page] = await db
    .select({ projectId: statusPages.projectId })
    .from(statusPages)
    .where(eq(statusPages.id, statusPageId))
    .limit(1);

  if (!page) return;
  if (!(await verifyProjectOwner(page.projectId))) return;

  await db.delete(statusPages).where(eq(statusPages.id, statusPageId));

  revalidatePath(`/projects`);
}
