"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, projects, onCallSchedules, onCallSlots, organizationMembers } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";

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

export async function createSchedule(
  projectId: string,
  name: string,
  timezone: string
): Promise<{ error?: string }> {
  try {
    const result = await requireProjectAdmin(projectId);
    if ("error" in result) return { error: result.error };

    const trimmedName = name.trim();
    if (!trimmedName) return { error: "Name is required." };

    // Limit: max 3 schedules per project
    const existing = await db
      .select({ id: onCallSchedules.id })
      .from(onCallSchedules)
      .where(eq(onCallSchedules.projectId, projectId));
    if (existing.length >= 3) {
      return { error: "Maximum 3 schedules per project." };
    }

    await db.insert(onCallSchedules).values({
      projectId,
      name: trimmedName,
      timezone: timezone || "UTC",
    });

    revalidatePath(`/projects/${result.project.slug}`);
    return {};
  } catch {
    return { error: "Failed to create schedule. Please try again." };
  }
}

export async function deleteSchedule(
  projectId: string,
  scheduleId: string
): Promise<{ error?: string }> {
  try {
    const result = await requireProjectAdmin(projectId);
    if ("error" in result) return { error: result.error };

    const [schedule] = await db
      .select()
      .from(onCallSchedules)
      .where(
        and(
          eq(onCallSchedules.id, scheduleId),
          eq(onCallSchedules.projectId, projectId)
        )
      )
      .limit(1);
    if (!schedule) return { error: "Schedule not found." };

    await db.delete(onCallSchedules).where(eq(onCallSchedules.id, scheduleId));

    revalidatePath(`/projects/${result.project.slug}`);
    return {};
  } catch {
    return { error: "Failed to delete schedule. Please try again." };
  }
}

export async function addSlot(
  projectId: string,
  scheduleId: string,
  userId: string,
  dayStart: number,
  dayEnd: number,
  hourStart: number,
  hourEnd: number
): Promise<{ error?: string }> {
  try {
    const result = await requireProjectAdmin(projectId);
    if ("error" in result) return { error: result.error };

    // Verify the schedule belongs to this project
    const [schedule] = await db
      .select()
      .from(onCallSchedules)
      .where(
        and(
          eq(onCallSchedules.id, scheduleId),
          eq(onCallSchedules.projectId, projectId)
        )
      )
      .limit(1);
    if (!schedule) return { error: "Schedule not found." };

    // Validate day/hour ranges
    if (dayStart < 0 || dayStart > 6 || dayEnd < 0 || dayEnd > 6)
      return { error: "Days must be 0 (Sun) to 6 (Sat)." };
    if (hourStart < 0 || hourStart > 23 || hourEnd < 0 || hourEnd > 23)
      return { error: "Hours must be 0-23." };

    // Limit: max 10 slots per schedule
    const existing = await db
      .select({ id: onCallSlots.id })
      .from(onCallSlots)
      .where(eq(onCallSlots.scheduleId, scheduleId));
    if (existing.length >= 10) {
      return { error: "Maximum 10 slots per schedule." };
    }

    await db.insert(onCallSlots).values({
      scheduleId,
      userId,
      dayStart,
      dayEnd,
      hourStart,
      hourEnd,
    });

    revalidatePath(`/projects/${result.project.slug}`);
    return {};
  } catch {
    return { error: "Failed to add slot. Please try again." };
  }
}

export async function removeSlot(
  projectId: string,
  slotId: string
): Promise<{ error?: string }> {
  try {
    const result = await requireProjectAdmin(projectId);
    if ("error" in result) return { error: result.error };

    // Verify the slot belongs to a schedule in this project
    const [slot] = await db
      .select({
        id: onCallSlots.id,
        scheduleId: onCallSlots.scheduleId,
      })
      .from(onCallSlots)
      .where(eq(onCallSlots.id, slotId))
      .limit(1);
    if (!slot) return { error: "Slot not found." };

    const [schedule] = await db
      .select()
      .from(onCallSchedules)
      .where(
        and(
          eq(onCallSchedules.id, slot.scheduleId),
          eq(onCallSchedules.projectId, projectId)
        )
      )
      .limit(1);
    if (!schedule) return { error: "Schedule not found in this project." };

    await db.delete(onCallSlots).where(eq(onCallSlots.id, slotId));

    revalidatePath(`/projects/${result.project.slug}`);
    return {};
  } catch {
    return { error: "Failed to remove slot. Please try again." };
  }
}
