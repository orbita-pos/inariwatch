/**
 * Mobile push notifications via Expo Push API.
 * Sends to all registered mobile devices for the alert's project owner.
 */

import { db, notificationChannels, projects } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import type { Alert } from "@/lib/db/schema";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export async function sendMobilePush(alert: Alert): Promise<void> {
  const [project] = await db
    .select({ userId: projects.userId })
    .from(projects)
    .where(eq(projects.id, alert.projectId))
    .limit(1);

  if (!project) return;

  // Find all mobile push channels for this user
  const channels = await db
    .select()
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.userId, project.userId),
        eq(notificationChannels.isActive, true)
      )
    );

  // Filter for mobile push tokens
  const mobileChannels = channels.filter((ch) => {
    const config = ch.config as { expoToken?: string; platform?: string };
    return config.platform === "mobile" && config.expoToken;
  });

  if (mobileChannels.length === 0) return;

  const emoji = alert.severity === "critical" ? "🔴" : alert.severity === "warning" ? "🟠" : "🔵";

  for (const ch of mobileChannels) {
    const config = ch.config as { expoToken: string };

    try {
      await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          to: config.expoToken,
          title: `${emoji} ${alert.title}`,
          body: alert.body?.slice(0, 200) || alert.severity,
          data: {
            alertId: alert.id,
            screen: "alert",
            severity: alert.severity,
          },
          sound: alert.severity === "critical" ? "critical.wav" : "default",
          priority: alert.severity === "critical" ? "high" : "normal",
          channelId: "alerts",
        }),
      });
    } catch {
      // Non-blocking — push failure shouldn't break alert pipeline
    }
  }
}
