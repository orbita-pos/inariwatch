"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, projects, uptimeMonitors } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { validatePublicUrl } from "@/lib/url-validation";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function requireProjectAdmin(projectId: string) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated." };

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!project) return { error: "Project not found or not authorized." };

  return { userId, project };
}

// ── Actions ──────────────────────────────────────────────────────────────────

export async function addMonitor(
  projectId: string,
  url: string,
  name: string,
  intervalSec: number = 60,
  expectedStatus: number = 200
): Promise<{ error?: string }> {
  try {
    const result = await requireProjectAdmin(projectId);
    if ("error" in result) return { error: result.error };

    const trimmedUrl = url.trim();
    if (!trimmedUrl || (!trimmedUrl.startsWith("https://") && !trimmedUrl.startsWith("http://"))) {
      return { error: "URL must start with http:// or https://" };
    }
    const urlCheck = validatePublicUrl(trimmedUrl);
    if (!urlCheck.valid) return { error: urlCheck.error ?? "Invalid URL" };

    const trimmedName = (name || "").trim() || new URL(trimmedUrl).hostname;

    if (![30, 60, 120, 300].includes(intervalSec)) {
      return { error: "Interval must be 30s, 60s, 2min, or 5min." };
    }

    // Limit: max 10 monitors per project
    const existing = await db
      .select({ id: uptimeMonitors.id })
      .from(uptimeMonitors)
      .where(eq(uptimeMonitors.projectId, projectId));
    if (existing.length >= 10) {
      return { error: "Maximum 10 monitors per project. Remove one first." };
    }

    await db.insert(uptimeMonitors).values({
      projectId,
      url: trimmedUrl,
      name: trimmedName,
      intervalSec,
      expectedStatus,
    });

    revalidatePath(`/projects/${result.project.slug}`);
    return {};
  } catch {
    return { error: "Failed to add monitor. Please try again." };
  }
}

export async function removeMonitor(
  projectId: string,
  monitorId: string
): Promise<{ error?: string }> {
  try {
    const result = await requireProjectAdmin(projectId);
    if ("error" in result) return { error: result.error };

    const [monitor] = await db
      .select()
      .from(uptimeMonitors)
      .where(
        and(
          eq(uptimeMonitors.id, monitorId),
          eq(uptimeMonitors.projectId, projectId)
        )
      )
      .limit(1);
    if (!monitor) return { error: "Monitor not found." };

    await db.delete(uptimeMonitors).where(eq(uptimeMonitors.id, monitorId));

    revalidatePath(`/projects/${result.project.slug}`);
    return {};
  } catch {
    return { error: "Failed to remove monitor. Please try again." };
  }
}

export async function toggleMonitor(
  projectId: string,
  monitorId: string,
  isActive: boolean
): Promise<{ error?: string }> {
  try {
    const result = await requireProjectAdmin(projectId);
    if ("error" in result) return { error: result.error };

    const [monitor] = await db
      .select()
      .from(uptimeMonitors)
      .where(
        and(
          eq(uptimeMonitors.id, monitorId),
          eq(uptimeMonitors.projectId, projectId)
        )
      )
      .limit(1);
    if (!monitor) return { error: "Monitor not found." };

    await db
      .update(uptimeMonitors)
      .set({ isActive })
      .where(eq(uptimeMonitors.id, monitorId));

    revalidatePath(`/projects/${result.project.slug}`);
    return {};
  } catch {
    return { error: "Failed to update monitor. Please try again." };
  }
}
