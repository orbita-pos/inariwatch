import { db, alerts } from "@/lib/db";
import { eq } from "drizzle-orm";
import type { McpUser } from "../auth";
import { userCanAccessProject } from "../helpers";

export async function execute(
  args: Record<string, unknown>,
  user: McpUser
): Promise<string> {
  const alertId = args.alert_id as string;
  if (!alertId) return "Error: alert_id is required.";

  const resolve = args.resolve !== false;

  const [alert] = await db
    .select({ id: alerts.id, projectId: alerts.projectId, title: alerts.title })
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alert) return `Error: Alert not found: ${alertId}`;
  if (!(await userCanAccessProject(user.userId, alert.projectId)))
    return "Error: Alert does not belong to your projects.";

  await db
    .update(alerts)
    .set({
      isRead: true,
      ...(resolve ? { isResolved: true, resolvedAt: new Date() } : {}),
    })
    .where(eq(alerts.id, alertId));

  return resolve
    ? `Alert resolved: ${alert.title}`
    : `Alert marked as read: ${alert.title}`;
}
