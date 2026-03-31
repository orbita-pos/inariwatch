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

  const [alert] = await db
    .select()
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alert) return `Error: Alert not found: ${alertId}`;

  const hasAccess = await userCanAccessProject(user.userId, alert.projectId);
  if (!hasAccess) return "Error: Alert does not belong to your projects.";

  if (alert.postmortem) {
    return `# Post-Mortem: ${alert.title}\n\n${alert.postmortem}`;
  }

  return JSON.stringify(
    {
      alert_id: alertId,
      title: alert.title,
      severity: alert.severity,
      status: alert.isResolved ? "resolved" : "open",
      note: alert.isResolved
        ? "No postmortem generated yet. A postmortem can be generated from the dashboard."
        : "Alert is still open. Postmortems are typically generated after resolution.",
    },
    null,
    2
  );
}
