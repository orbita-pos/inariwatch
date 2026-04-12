import { db, alerts, substrateRecordings } from "@/lib/db";
import { eq } from "drizzle-orm";
import type { McpUser } from "../auth";
import { userCanAccessProject } from "../helpers";

const SIMULATION_PROMPT = `You are an expert SRE simulating whether a proposed fix would resolve a production bug.

You have two inputs:
1. A Substrate I/O recording — the exact sequence of HTTP calls, DB queries, and file operations that happened before the crash
2. A proposed fix description

Analyze:
1. Would this fix prevent the crash shown in the recording? (yes/no/uncertain)
2. Probability of success (0-100%)
3. Potential risks or side effects of this fix
4. Could this fix break any of the other I/O operations in the recording?

Be specific. Reference actual events from the recording.`;

export async function execute(
  args: Record<string, unknown>,
  user: McpUser
): Promise<string> {
  const alertId = args.alert_id as string;
  const fixDescription = args.fix_description as string;

  if (!alertId) return "Error: alert_id is required.";
  if (!fixDescription) return "Error: fix_description is required.";

  const [alert] = await db.select().from(alerts).where(eq(alerts.id, alertId)).limit(1);
  if (!alert) return `Error: Alert not found: ${alertId}`;
  if (!(await userCanAccessProject(user.userId, alert.projectId)))
    return "Error: Alert does not belong to your projects.";

  const [recording] = await db
    .select()
    .from(substrateRecordings)
    .where(eq(substrateRecordings.alertId, alertId))
    .limit(1);

  if (!recording) {
    return JSON.stringify({
      alert_id: alertId,
      simulation: null,
      note: "Cannot simulate without a Substrate recording. Enable: INARIWATCH_SUBSTRATE=true",
    }, null, 2);
  }

  const recordingContext = recording.context ?? JSON.stringify(recording.events ?? []).slice(0, 4000);

  // Sampling-first: let the client LLM simulate the fix
  return JSON.stringify({
    alert_id: alertId,
    title: alert.title,
    recording_events: recording.eventCount,
    fix_description: fixDescription,
    _sampling_request: {
      description: "Simulate whether this fix resolves the bug using the I/O recording below.",
      systemPrompt: SIMULATION_PROMPT,
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Alert: ${alert.title}\nSeverity: ${alert.severity}\nStack: ${(alert.body ?? "").slice(0, 1000)}\n\nI/O Recording (${recording.eventCount} events, ${recording.durationMs}ms):\n${recordingContext}\n\nProposed fix:\n${fixDescription}`,
        },
      }],
      context: { alert_id: alertId, tool: "simulate_fix" },
      maxTokens: 2000,
    },
  }, null, 2);
}
