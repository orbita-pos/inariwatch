import { db, alerts, substrateRecordings } from "@/lib/db";
import { eq } from "drizzle-orm";
import type { McpUser } from "../auth";
import { userCanAccessProject } from "../helpers";

export async function execute(
  args: Record<string, unknown>,
  user: McpUser
): Promise<string> {
  const alertId = args.alert_id as string;
  if (!alertId) return "Error: alert_id is required.";

  // Verify alert belongs to user
  const [alert] = await db
    .select()
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alert) return `Error: Alert not found: ${alertId}`;

  const hasAccess = await userCanAccessProject(user.userId, alert.projectId);
  if (!hasAccess) return "Error: Alert does not belong to your projects.";

  // Look for substrate recording linked to this alert
  const [recording] = await db
    .select()
    .from(substrateRecordings)
    .where(eq(substrateRecordings.alertId, alertId))
    .limit(1);

  if (!recording) {
    return JSON.stringify(
      {
        alert_id: alertId,
        title: alert.title,
        body: alert.body?.slice(0, 2000),
        severity: alert.severity,
        ai_reasoning: alert.aiReasoning?.slice(0, 1000),
        sources: alert.sourceIntegrations,
        substrate_recording: null,
        note: "No substrate recording found for this alert. Enable with INARIWATCH_SUBSTRATE=true",
      },
      null,
      2
    );
  }

  let out = `Substrate I/O recording for: ${alert.title}\n${"=".repeat(50)}\n\n`;
  out += `Recording: ${recording.recordingId}\n`;
  out += `Command: ${recording.command ?? "unknown"}\n`;
  out += `Runtime: ${recording.runtime ?? "node"}\n`;
  out += `Events: ${recording.eventCount ?? 0} I/O operations\n`;
  out += `Duration: ${recording.durationMs ?? 0}ms\n\n`;

  if (recording.context) {
    out += `Context:\n${recording.context}\n\n`;
  }

  const categories = recording.categories as Record<string, number> | null;
  if (categories && typeof categories === "object") {
    out += "I/O categories:\n";
    for (const [cat, count] of Object.entries(categories)) {
      out += `  • ${cat}: ${count}\n`;
    }
    out += "\n";
  }

  // Include alert context too
  out += `Alert context:\n`;
  out += `  Severity: ${alert.severity}\n`;
  out += `  Sources: ${(alert.sourceIntegrations ?? []).join(", ")}\n`;
  if (alert.aiReasoning) {
    out += `  AI reasoning: ${alert.aiReasoning.slice(0, 500)}\n`;
  }

  return out;
}
