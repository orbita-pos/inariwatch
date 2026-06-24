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

  const verbose = args.verbose === true;

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
      title: alert.title,
      recording: null,
      note: "No Substrate recording found for this alert. Enable recording: INARIWATCH_SUBSTRATE=true in your .env. The SDK will capture all I/O (HTTP, DB, file ops) in a 60-second ring buffer and attach it to errors automatically.",
    }, null, 2);
  }

  // Build the I/O timeline
  const events = (recording.events ?? []) as Array<{
    type?: string;
    timestamp?: string;
    method?: string;
    url?: string;
    statusCode?: number;
    duration?: number;
    query?: string;
    path?: string;
    operation?: string;
    hostname?: string;
    error?: string;
    body?: string;
  }>;

  const categories = recording.categories as Record<string, number> | null;

  let timeline = `BUG REPRODUCTION — ${alert.title}\n${"=".repeat(60)}\n\n`;
  timeline += `Recording: ${recording.recordingId}\n`;
  timeline += `Duration: ${recording.durationMs ?? 0}ms | Events: ${recording.eventCount ?? 0}\n`;
  timeline += `Runtime: ${recording.runtime ?? "node"} | Command: ${recording.command ?? "unknown"}\n\n`;

  if (categories && Object.keys(categories).length > 0) {
    timeline += "I/O Summary:\n";
    for (const [cat, count] of Object.entries(categories)) {
      timeline += `  ${cat}: ${count}\n`;
    }
    timeline += "\n";
  }

  timeline += `Timeline (chronological):\n${"─".repeat(50)}\n`;

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const ts = e.timestamp ? new Date(e.timestamp).toISOString().slice(11, 23) : `event_${i}`;
    const type = (e.type ?? "unknown").toUpperCase().padEnd(8);

    let detail = "";
    switch (e.type) {
      case "http":
        detail = `${e.method ?? "?"} ${e.url ?? "?"} → ${e.statusCode ?? "?"}`;
        if (e.duration) detail += ` (${e.duration}ms)`;
        if (verbose && e.body) detail += `\n         Body: ${e.body.slice(0, 500)}`;
        break;
      case "db":
        detail = e.query ? e.query.slice(0, verbose ? 500 : 100) : "query";
        if (e.duration) detail += ` (${e.duration}ms)`;
        break;
      case "file":
        detail = `${e.operation ?? "read"} ${e.path ?? "?"}`;
        break;
      case "dns":
        detail = `resolve ${e.hostname ?? "?"}`;
        if (e.duration) detail += ` (${e.duration}ms)`;
        break;
      case "error":
      case "exception":
        detail = `⚠️ ${e.error ?? "unknown error"}`;
        break;
      default:
        detail = JSON.stringify(e).slice(0, verbose ? 300 : 100);
    }

    timeline += `  [${ts}] ${type} ${detail}\n`;
  }

  if (events.length === 0 && recording.context) {
    timeline += `\n${recording.context}\n`;
  }

  timeline += `\n${"─".repeat(50)}\n`;
  timeline += `CRASH: ${alert.title}\n`;
  timeline += `Severity: ${alert.severity}\n`;
  if (alert.body) timeline += `Stack: ${alert.body.slice(0, verbose ? 3000 : 500)}\n`;

  return timeline;
}
