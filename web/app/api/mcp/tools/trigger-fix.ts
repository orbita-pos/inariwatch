import { db, alerts, projects, remediationSessions } from "@/lib/db";
import { eq } from "drizzle-orm";
import type { McpUser } from "../auth";
import { userCanAccessProject } from "../helpers";

export async function execute(
  args: Record<string, unknown>,
  user: McpUser
): Promise<string> {
  const alertId = args.alert_id as string;
  if (!alertId) return "Error: alert_id is required.";

  const dryRun = args.dry_run === true;

  const [alert] = await db
    .select()
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alert) return `Error: Alert not found: ${alertId}`;

  const hasAccess = await userCanAccessProject(user.userId, alert.projectId);
  if (!hasAccess) return "Error: Alert does not belong to your projects.";

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, alert.projectId))
    .limit(1);

  if (!project) return "Error: Project not found.";

  if (dryRun) {
    return JSON.stringify(
      {
        mode: "dry_run",
        alert_id: alertId,
        alert_title: alert.title,
        project: project.name,
        note: "Dry run mode. In production, this would: diagnose → read code → generate fix → self-review → push → CI → PR.",
        ai_reasoning: alert.aiReasoning?.slice(0, 500) ?? "No AI analysis yet.",
      },
      null,
      2
    );
  }

  // Create a remediation session
  const [session] = await db
    .insert(remediationSessions)
    .values({
      alertId,
      projectId: project.id,
      userId: user.userId,
      status: "analyzing",
      attempt: 1,
      maxAttempts: 3,
      steps: [
        {
          id: "mcp_trigger",
          type: "info",
          message: "Remediation triggered via MCP",
          status: "completed",
          timestamp: new Date().toISOString(),
        },
      ],
    })
    .returning({ id: remediationSessions.id });

  return JSON.stringify(
    {
      status: "started",
      session_id: session.id,
      alert_id: alertId,
      project: project.name,
      note: "Remediation pipeline started. Monitor progress at app.inariwatch.com or use the dashboard SSE stream.",
      stream_url: `https://app.inariwatch.com/api/remediation/stream/${session.id}`,
    },
    null,
    2
  );
}

/**
 * Streaming version: returns SSE events as the remediation progresses.
 * Used when the MCP client supports Streamable HTTP (text/event-stream responses).
 */
export async function executeStream(
  args: Record<string, unknown>,
  user: McpUser,
  emit: (event: string, data: unknown) => void
): Promise<void> {
  const alertId = args.alert_id as string;
  if (!alertId) { emit("error", { message: "alert_id is required" }); return; }

  const dryRun = args.dry_run === true;

  const [alert] = await db
    .select()
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alert) { emit("error", { message: `Alert not found: ${alertId}` }); return; }

  const hasAccess = await userCanAccessProject(user.userId, alert.projectId);
  if (!hasAccess) { emit("error", { message: "Alert does not belong to your projects." }); return; }

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, alert.projectId))
    .limit(1);

  if (!project) { emit("error", { message: "Project not found." }); return; }

  if (dryRun) {
    emit("result", {
      mode: "dry_run",
      alert_id: alertId,
      alert_title: alert.title,
      project: project.name,
      ai_reasoning: alert.aiReasoning?.slice(0, 500) ?? "No AI analysis yet.",
    });
    return;
  }

  // Create session
  const [session] = await db
    .insert(remediationSessions)
    .values({
      alertId,
      projectId: project.id,
      userId: user.userId,
      status: "analyzing",
      attempt: 1,
      maxAttempts: 3,
      steps: [
        {
          id: "mcp_trigger",
          type: "info",
          message: "Remediation triggered via MCP (streaming)",
          status: "completed",
          timestamp: new Date().toISOString(),
        },
      ],
    })
    .returning({ id: remediationSessions.id });

  emit("started", { session_id: session.id, alert_id: alertId, project: project.name });

  // Try to run remediation with streaming emit
  try {
    const { runRemediation } = await import("@/lib/ai/remediate");
    await runRemediation(session.id, (step) => {
      emit("step", step);
    });
    emit("done", { session_id: session.id, status: "completed" });
  } catch (e) {
    emit("error", {
      session_id: session.id,
      message: e instanceof Error ? e.message : "Remediation failed",
    });
  }
}
