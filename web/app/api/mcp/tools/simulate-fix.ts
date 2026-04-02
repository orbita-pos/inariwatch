import { db, alerts, substrateRecordings, apiKeys } from "@/lib/db";
import { eq } from "drizzle-orm";
import { decrypt } from "@/lib/crypto";
import { callAI } from "@/lib/ai/client";
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

  // Get AI key
  const AI_SERVICES = ["claude", "openai", "grok", "deepseek", "gemini"];
  const keys = await db.select().from(apiKeys).where(eq(apiKeys.userId, user.userId));
  const aiKey = keys.find((k) => AI_SERVICES.includes(k.service));

  if (!aiKey) {
    return JSON.stringify({
      alert_id: alertId,
      recording_events: recording.eventCount,
      fix_description: fixDescription,
      _sampling_request: {
        description: "No AI key configured. Use your client LLM to simulate this fix.",
        systemPrompt: SIMULATION_PROMPT,
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `Alert: ${alert.title}\nSeverity: ${alert.severity}\n\nI/O Recording (${recording.eventCount} events):\n${recording.context ?? JSON.stringify(recording.events ?? []).slice(0, 3000)}\n\nProposed fix:\n${fixDescription}`,
          },
        }],
        maxTokens: 2000,
      },
    }, null, 2);
  }

  const decryptedKey = decrypt(aiKey.keyEncrypted);
  const recordingContext = recording.context ?? JSON.stringify(recording.events ?? []).slice(0, 4000);

  try {
    const result = await callAI(decryptedKey, SIMULATION_PROMPT, [{
      role: "user",
      content: `Alert: ${alert.title}\nSeverity: ${alert.severity}\nStack: ${(alert.body ?? "").slice(0, 1000)}\n\nI/O Recording (${recording.eventCount} events, ${recording.durationMs}ms):\n${recordingContext}\n\nProposed fix:\n${fixDescription}`,
    }]);

    return JSON.stringify({
      alert_id: alertId,
      title: alert.title,
      recording_events: recording.eventCount,
      fix_description: fixDescription,
      simulation: result,
      source: "ai",
    }, null, 2);
  } catch (e) {
    return `Error running simulation: ${e instanceof Error ? e.message : "unknown"}`;
  }
}
