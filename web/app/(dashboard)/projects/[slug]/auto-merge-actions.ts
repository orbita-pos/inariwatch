"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, projects, projectMembers } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { AutoMergeConfig } from "@/lib/db/schema";

async function requireAdmin(
  projectId: string
): Promise<{ userId: string } | { error: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated." };

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (project) return { userId };

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

export async function updateAutoMergeConfig(
  projectId: string,
  config: AutoMergeConfig
): Promise<{ error?: string }> {
  try {
    const result = await requireAdmin(projectId);
    if ("error" in result) return { error: result.error };

    // Validate
    if (config.minConfidence < 50 || config.minConfidence > 100) {
      return { error: "Minimum confidence must be between 50 and 100." };
    }
    if (config.maxLinesChanged < 5 || config.maxLinesChanged > 500) {
      return { error: "Max lines changed must be between 5 and 500." };
    }

    const sanitized: AutoMergeConfig = {
      enabled: !!config.enabled,
      minConfidence: Math.round(config.minConfidence),
      maxLinesChanged: Math.round(config.maxLinesChanged),
      requireSelfReview: !!config.requireSelfReview,
      postMergeMonitor: !!config.postMergeMonitor,
      autoRevert: !!config.autoRevert,
    };

    await db
      .update(projects)
      .set({ autoMergeConfig: sanitized })
      .where(eq(projects.id, projectId));

    const [project] = await db
      .select({ slug: projects.slug })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (project) revalidatePath(`/projects/${project.slug}`);

    return {};
  } catch {
    return { error: "Failed to update auto-merge settings. Please try again." };
  }
}
