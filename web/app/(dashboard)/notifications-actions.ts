"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, alerts, getUserProjectIds } from "@/lib/db";
import { and, inArray, eq, desc } from "drizzle-orm";

export interface NotificationItem {
  id:        string;
  title:     string;
  severity:  "critical" | "warning" | "info";
  isRead:    boolean;
  createdAt: string;
}

export async function getRecentNotifications(): Promise<NotificationItem[]> {
  const session = await getServerSession(authOptions);
  const userId  = (session?.user as { id?: string })?.id;
  if (!userId) return [];

  const projectIds = await getUserProjectIds(userId);
  if (projectIds.length === 0) return [];

  const rows = await db
    .select({
      id:        alerts.id,
      title:     alerts.title,
      severity:  alerts.severity,
      isRead:    alerts.isRead,
      createdAt: alerts.createdAt,
    })
    .from(alerts)
    .where(and(
      inArray(alerts.projectId, projectIds),
      eq(alerts.isResolved, false),
    ))
    .orderBy(desc(alerts.createdAt))
    .limit(7);

  return rows.map((r) => ({
    id:        r.id,
    title:     r.title,
    severity:  r.severity,
    isRead:    r.isRead,
    createdAt: r.createdAt.toISOString(),
  }));
}
