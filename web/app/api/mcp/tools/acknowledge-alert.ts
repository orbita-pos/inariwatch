import type { McpUser } from "../auth";
import { userCanAccessProject } from "../helpers";
import { getAlert, acknowledgeAlert } from "@/lib/services/alerts.service";

export async function execute(
  args: Record<string, unknown>,
  user: McpUser
): Promise<string> {
  const alertId = args.alert_id as string;
  if (!alertId) return "Error: alert_id is required.";

  const alert = await getAlert(alertId);
  if (!alert) return `Error: Alert not found: ${alertId}`;
  if (!(await userCanAccessProject(user.userId, alert.projectId)))
    return "Error: Alert does not belong to your projects.";

  await acknowledgeAlert(alertId);

  return `Alert acknowledged (marked as read): ${alert.title}`;
}
