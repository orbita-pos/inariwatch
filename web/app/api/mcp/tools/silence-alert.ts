import type { McpUser } from "../auth";
import { userCanAccessProject } from "../helpers";
import { getAlert, silenceAlert } from "@/lib/services/alerts.service";

export async function execute(
  args: Record<string, unknown>,
  user: McpUser
): Promise<string> {
  const alertId = args.alert_id as string;
  if (!alertId) return "Error: alert_id is required.";

  const resolve = args.resolve !== false;

  const alert = await getAlert(alertId);
  if (!alert) return `Error: Alert not found: ${alertId}`;
  if (!(await userCanAccessProject(user.userId, alert.projectId)))
    return "Error: Alert does not belong to your projects.";

  const result = await silenceAlert(alertId, resolve);
  if (!result.ok) return "Error: Failed to update alert.";

  return resolve
    ? `Alert resolved: ${result.title}`
    : `Alert marked as read: ${result.title}`;
}
