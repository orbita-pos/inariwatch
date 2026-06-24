import { db, onCallSchedules, onCallSlots, onCallOverrides, notificationChannels } from "@/lib/db";
import { eq, and, lte, gte } from "drizzle-orm";

/**
 * Resolves who is currently on-call for a project.
 * Returns the userId of the on-call person for the specified level, or null if no schedule exists.
 * @param level 1 for Primary, 2 for Secondary, etc. Default is 1.
 */
export async function getCurrentOnCallUserId(
  projectId: string,
  level: number = 1
): Promise<string | null> {
  // Get all active schedules for this project
  const schedules = await db
    .select()
    .from(onCallSchedules)
    .where(eq(onCallSchedules.projectId, projectId));

  if (schedules.length === 0) return null;

  // For each schedule, check if any slot covers the current time
  for (const schedule of schedules) {
    const now = new Date();

    // Convert to the schedule's timezone
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: schedule.timezone,
      hour: "numeric",
      hour12: false,
      weekday: "short",
    });
    const parts = formatter.formatToParts(now);
    const weekdayStr = parts.find((p) => p.type === "weekday")?.value ?? "";
    const hour = parseInt(
      parts.find((p) => p.type === "hour")?.value ?? "0",
      10
    );

    // Map weekday string to number (0=Sunday...6=Saturday)
    const dayMap: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    const currentDay = dayMap[weekdayStr] ?? 0;

    // 1. Check if there's an active override for this schedule + level
    const [override] = await db
      .select({ userId: onCallOverrides.userId })
      .from(onCallOverrides)
      .where(
        and(
          eq(onCallOverrides.scheduleId, schedule.id),
          eq(onCallOverrides.level, level),
          lte(onCallOverrides.startsAt, now),
          gte(onCallOverrides.endsAt, now)
        )
      )
      .limit(1);

    if (override) {
      return override.userId;
    }

    // 2. Otherwise, check regular slots
    const slots = await db
      .select()
      .from(onCallSlots)
      .where(
        and(
          eq(onCallSlots.scheduleId, schedule.id),
          eq(onCallSlots.level, level)
        )
      );

    for (const slot of slots) {
      // Check if current day is within the slot's day range
      let dayInRange = false;
      if (slot.dayStart <= slot.dayEnd) {
        // Normal range: Mon(1) to Fri(5)
        dayInRange = currentDay >= slot.dayStart && currentDay <= slot.dayEnd;
      } else {
        // Wrapping range: Fri(5) to Mon(1) = Fri, Sat, Sun, Mon
        dayInRange = currentDay >= slot.dayStart || currentDay <= slot.dayEnd;
      }

      if (!dayInRange) continue;

      // Check if current hour is within the slot's hour range
      let hourInRange = false;
      if (slot.hourStart <= slot.hourEnd) {
        hourInRange = hour >= slot.hourStart && hour <= slot.hourEnd;
      } else {
        hourInRange = hour >= slot.hourStart || hour <= slot.hourEnd;
      }

      if (hourInRange) {
        return slot.userId;
      }
    }
  }

  return null;
}

/**
 * Gets the notification channel for the on-call user.
 * Returns the first active channel for the user, or null.
 */
export async function getOnCallChannel(
  userId: string
): Promise<string | null> {
  const [channel] = await db
    .select({ id: notificationChannels.id })
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.userId, userId),
        eq(notificationChannels.isActive, true)
      )
    )
    .limit(1);

  return channel?.id ?? null;
}
