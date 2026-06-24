"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, projects, projectMembers, projectIntegrations } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { decryptConfig } from "@/lib/crypto";
import * as gh from "@/lib/services/github-api";
import { normalizeRepo } from "@/lib/webhooks/resolve-repo";

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

  return { error: "You must be a project admin to change the default repository." };
}

/**
 * Fetch the list of repos accessible via the project's GitHub integration,
 * so the UI can offer a selector instead of a free-text input. Returns an
 * empty list (and no error) when no GitHub integration is connected — the
 * client renders an info banner in that case.
 */
export async function fetchProjectRepos(
  projectId: string,
): Promise<{ repos: string[]; owner: string | null; error?: string }> {
  const result = await requireAdmin(projectId);
  if ("error" in result) return { repos: [], owner: null, error: result.error };

  const integrations = await db
    .select()
    .from(projectIntegrations)
    .where(and(
      eq(projectIntegrations.projectId, projectId),
      eq(projectIntegrations.service, "github"),
      eq(projectIntegrations.isActive, true),
    ));
  const ghInteg = integrations[0];
  if (!ghInteg) return { repos: [], owner: null };

  try {
    const cfg = decryptConfig(ghInteg.configEncrypted);
    const token = cfg.token as string | undefined;
    const owner = cfg.owner as string | undefined;
    if (!token || !owner) return { repos: [], owner: null };
    const repos = await gh.listOwnerRepos(token, owner);
    return { repos, owner };
  } catch {
    return { repos: [], owner: null, error: "Could not load repositories from GitHub. Check the integration." };
  }
}

/**
 * Persist the project's default repository (owner/repo form). Pass an empty
 * string to clear the setting.
 */
export async function setDefaultRepo(
  projectId: string,
  rawInput: string,
): Promise<{ error?: string; saved?: string | null }> {
  const result = await requireAdmin(projectId);
  if ("error" in result) return { error: result.error };

  const trimmed = typeof rawInput === "string" ? rawInput.trim() : "";
  let value: string | null = null;
  if (trimmed) {
    value = normalizeRepo(trimmed);
    if (!value) {
      return { error: `"${trimmed.slice(0, 60)}" is not a valid owner/repo.` };
    }
  }

  try {
    await db.update(projects).set({ defaultRepo: value }).where(eq(projects.id, projectId));
    revalidatePath(`/projects/${result.slug}`);
    return { saved: value };
  } catch {
    return { error: "Failed to save. Please try again." };
  }
}
