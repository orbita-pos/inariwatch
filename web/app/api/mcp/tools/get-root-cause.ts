import { db, alerts } from "@/lib/db";
import { eq } from "drizzle-orm";
import type { McpUser } from "../auth";
import { userCanAccessProject } from "../helpers";
import { DIAGNOSIS_PROMPT, buildAnalyzePrompt } from "@/lib/services/diagnosis.service";
import { formatContext } from "../format-context";

export async function execute(
  args: Record<string, unknown>,
  user: McpUser
): Promise<string> {
  const alertId = args.alert_id as string;
  if (!alertId) return "Error: alert_id is required.";

  const [alert] = await db
    .select({ id: alerts.id, projectId: alerts.projectId, title: alerts.title, severity: alerts.severity, body: alerts.body, sourceIntegrations: alerts.sourceIntegrations, correlationData: alerts.correlationData, aiReasoning: alerts.aiReasoning })
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alert) return `Error: Alert not found: ${alertId}`;
  if (!(await userCanAccessProject(user.userId, alert.projectId)))
    return "Error: Alert does not belong to your projects.";

  // Return cached analysis from auto-analyze if available
  if (alert.aiReasoning) {
    const contextStr = alert.correlationData
      ? formatContext(alert.correlationData as Record<string, unknown>)
      : "";

    return JSON.stringify({
      alert_id: alertId,
      title: alert.title,
      severity: alert.severity,
      root_cause_analysis: alert.aiReasoning,
      source: "cached",
      ...(contextStr ? { context: contextStr } : {}),
    }, null, 2);
  }

  // No cached analysis — let the client LLM diagnose via sampling
  const userMessage = buildAnalyzePrompt({
    title: alert.title,
    severity: alert.severity,
    body: alert.body ?? "",
    sourceIntegrations: alert.sourceIntegrations ?? [],
  });

  // Enrich with capture SDK context (git, breadcrumbs, env, request) — beyond server AI parity
  const correlationContext = alert.correlationData
    ? formatContext(alert.correlationData as Record<string, unknown>)
    : "";
  const enrichedMessage = correlationContext
    ? `${userMessage}\n\nCapture SDK context:\n${correlationContext}`
    : userMessage;

  return JSON.stringify({
    alert_id: alertId,
    title: alert.title,
    severity: alert.severity,
    _sampling_request: {
      description: "Analyze this alert using your LLM, then call sampling/createMessage with the result.",
      messages: [{ role: "user", content: { type: "text", text: enrichedMessage } }],
      systemPrompt: DIAGNOSIS_PROMPT,
      context: { alert_id: alertId, tool: "get_root_cause" },
      maxTokens: 2000,
    },
  }, null, 2);
}
