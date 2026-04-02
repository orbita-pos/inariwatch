import { db, alerts } from "@/lib/db";
import { eq } from "drizzle-orm";
import type { McpUser } from "../auth";
import { userCanAccessProject } from "../helpers";
import { diagnoseAlert, DIAGNOSIS_PROMPT, buildAnalyzePrompt } from "@/lib/services/diagnosis.service";
import { formatContext } from "../format-context";

export async function execute(
  args: Record<string, unknown>,
  user: McpUser
): Promise<string> {
  const alertId = args.alert_id as string;
  if (!alertId) return "Error: alert_id is required.";

  const [alert] = await db
    .select({ id: alerts.id, projectId: alerts.projectId, title: alerts.title, severity: alerts.severity, body: alerts.body, sourceIntegrations: alerts.sourceIntegrations, correlationData: alerts.correlationData })
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alert) return `Error: Alert not found: ${alertId}`;
  if (!(await userCanAccessProject(user.userId, alert.projectId)))
    return "Error: Alert does not belong to your projects.";

  const result = await diagnoseAlert(alertId, user.userId);

  if (result.source === "none") {
    // No AI key — return sampling request for client-side LLM
    const userMessage = buildAnalyzePrompt({
      title: alert.title,
      severity: alert.severity,
      body: alert.body ?? "",
      sourceIntegrations: alert.sourceIntegrations ?? [],
    });

    return JSON.stringify({
      alert_id: alertId,
      title: alert.title,
      severity: alert.severity,
      _sampling_request: {
        description: "No AI key configured. Use your client LLM to analyze this alert, then call sampling/createMessage with the result.",
        messages: [{ role: "user", content: { type: "text", text: userMessage } }],
        systemPrompt: DIAGNOSIS_PROMPT,
        context: { alert_id: alertId },
        maxTokens: 2000,
      },
    }, null, 2);
  }

  const contextStr = alert.correlationData
    ? formatContext(alert.correlationData as Record<string, unknown>)
    : "";

  return JSON.stringify({
    alert_id: alertId,
    title: alert.title,
    severity: alert.severity,
    root_cause_analysis: result.analysis,
    source: result.source,
    ...(contextStr ? { context: contextStr } : {}),
  }, null, 2);
}
