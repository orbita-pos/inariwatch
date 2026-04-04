import type { McpUser } from "../auth";
import { userCanAccessProject } from "../helpers";
import { getAlert, reopenAlert } from "@/lib/services/alerts.service";

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

  await reopenAlert(alertId);

  return `Alert reopened: ${alert.title}`;
}
