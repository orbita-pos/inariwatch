"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, projects, projectMembers } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { validateAllowedOriginEntry } from "@/lib/replay-origin";

const MAX_ENTRIES = 20;

async function requireAdmin(
  projectId: string,
): Promise<{ userId: string; slug: string } | { error: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated." };

  const [project] = await db
    .select({ slug: projects.slug, ownerId: projects.userId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return { error: "Project not found." };

  if (project.ownerId === userId) return { userId, slug: project.slug };

  const [member] = await db
    .select()
    .from(projectMembers)
    .where(and(
      eq(projectMembers.projectId, projectId),
      eq(projectMembers.userId, userId),
      eq(projectMembers.role, "admin"),
    ))
    .limit(1);
  if (member) return { userId, slug: project.slug };

  return { error: "You must be a project admin to change allowed origins." };
}

/**
 * Replace the project's allowed_origins list. The whole list is sent by the
 * client each time — simpler than diffing and naturally idempotent. An empty
 * list re-enables the pre-0048 "accept any Origin" behaviour, which is the
 * escape hatch if a user locks themselves out.
 */
export async function updateAllowedOrigins(
  projectId: string,
  entries: string[],
): Promise<{ error?: string }> {
  const result = await requireAdmin(projectId);
  if ("error" in result) return { error: result.error };

  if (!Array.isArray(entries)) return { error: "Invalid payload." };
  if (entries.length > MAX_ENTRIES) {
    return { error: `At most ${MAX_ENTRIES} allowed origins.` };
  }

  // Normalise + validate each entry before it hits the DB
  const cleaned: string[] = [];
  for (const raw of entries) {
    if (typeof raw !== "string") return { error: "Entries must be strings." };
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const err = validateAllowedOriginEntry(trimmed);
    if (err) return { error: `"${trimmed.slice(0, 60)}" — ${err}` };
    if (!cleaned.includes(trimmed)) cleaned.push(trimmed);
  }

  try {
    await db
      .update(projects)
      .set({ allowedOrigins: cleaned })
      .where(eq(projects.id, projectId));
    revalidatePath(`/projects/${result.slug}`);
    return {};
  } catch {
    return { error: "Failed to save. Please try again." };
  }
}
