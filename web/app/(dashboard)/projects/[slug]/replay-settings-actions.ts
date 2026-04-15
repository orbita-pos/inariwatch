"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, projects, projectMembers, users } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { ReplaySettings } from "@/lib/db/schema";
import { DEFAULT_REPLAY_SETTINGS } from "@/lib/db/schema";

const MAX_BUFFER_SECONDS = 300;   // 5 minutes of pre-error context is enough
const MIN_BUFFER_SECONDS = 15;
const MAX_RETENTION_FREE = 7;
const MAX_RETENTION_PRO = 90;

async function requireAdminAndPlan(
  projectId: string,
): Promise<
  | { userId: string; slug: string; plan: "free" | "pro" }
  | { error: string }
> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated." };

  const [project] = await db
    .select({ slug: projects.slug, ownerId: projects.userId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return { error: "Project not found." };

  // Auth: project owner or project admin member
  let isAdmin = project.ownerId === userId;
  if (!isAdmin) {
    const [member] = await db
      .select()
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, userId),
          eq(projectMembers.role, "admin"),
        ),
      )
      .limit(1);
    if (member) isAdmin = true;
  }
  if (!isAdmin) return { error: "You must be a project admin." };

  // Plan lookup — used to gate sessionSampleRate + max retention
  const [userRow] = await db
    .select({ plan: users.plan })
    .from(users)
    .where(eq(users.id, project.ownerId))
    .limit(1);
  const plan = (userRow?.plan as "free" | "pro") ?? "free";

  return { userId, slug: project.slug, plan };
}

/**
 * Replace the project's replay_settings. The whole object is sent every time
 * (simpler than diffing, naturally idempotent). We normalise + enforce plan
 * limits before writing — so a hand-crafted request can't bypass Pro gating.
 */
export async function updateReplaySettings(
  projectId: string,
  patch: ReplaySettings,
): Promise<{ error?: string }> {
  const result = await requireAdminAndPlan(projectId);
  if ("error" in result) return { error: result.error };

  try {
    const cleaned = normaliseAndGate(patch, result.plan);
    await db
      .update(projects)
      .set({ replaySettings: cleaned })
      .where(eq(projects.id, projectId));
    revalidatePath(`/projects/${result.slug}`);
    return {};
  } catch (err) {
    if (err instanceof ValidationError) return { error: err.message };
    return { error: "Failed to save replay settings." };
  }
}

class ValidationError extends Error {}

function clampRate(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Validate + enforce plan limits. Never trust the client payload — Free users
 * who tamper with the form and post sessionSampleRate=1.0 still get 0.
 */
function normaliseAndGate(patch: ReplaySettings, plan: "free" | "pro"): ReplaySettings {
  const out: ReplaySettings = {};

  if (patch.enabled !== undefined) out.enabled = !!patch.enabled;

  if (patch.errorSampleRate !== undefined) {
    out.errorSampleRate = clampRate(patch.errorSampleRate, DEFAULT_REPLAY_SETTINGS.errorSampleRate);
  }

  if (patch.sessionSampleRate !== undefined) {
    const raw = clampRate(patch.sessionSampleRate, 0);
    out.sessionSampleRate = plan === "pro" ? raw : 0;   // hard-gated on Free
  }

  if (patch.bufferSeconds !== undefined) {
    if (typeof patch.bufferSeconds !== "number" || !Number.isFinite(patch.bufferSeconds)) {
      throw new ValidationError("bufferSeconds must be a number");
    }
    const clamped = Math.round(Math.max(MIN_BUFFER_SECONDS, Math.min(MAX_BUFFER_SECONDS, patch.bufferSeconds)));
    out.bufferSeconds = clamped;
  }

  if (patch.retentionDays !== undefined) {
    if (typeof patch.retentionDays !== "number" || !Number.isFinite(patch.retentionDays)) {
      throw new ValidationError("retentionDays must be a number");
    }
    const max = plan === "pro" ? MAX_RETENTION_PRO : MAX_RETENTION_FREE;
    out.retentionDays = Math.round(Math.max(1, Math.min(max, patch.retentionDays)));
  }

  if (patch.piiClassifier !== undefined) {
    if (patch.piiClassifier !== "ai" && patch.piiClassifier !== "heuristic" && patch.piiClassifier !== false) {
      throw new ValidationError(`Invalid piiClassifier: ${String(patch.piiClassifier)}`);
    }
    out.piiClassifier = patch.piiClassifier;
  }

  return out;
}
