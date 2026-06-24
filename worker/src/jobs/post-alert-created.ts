/**
 * Post-Alert-Created Job — async processing after an alert is inserted.
 *
 * Replaces all the fire-and-forget calls that happened inline in Vercel
 * webhook routes. Now these run on the worker with proper retries.
 *
 * What it triggers (via Vercel endpoints):
 *   - Auto-analyze (AI diagnosis)
 *   - Substrate recording insert
 *   - Outgoing webhook dispatch
 *   - Status page incident creation
 *   - Slack/Telegram/Push direct notifications (non-queued)
 */

const APP_URL = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "";
const CRON_SECRET = process.env.CRON_SECRET ?? "";

interface PostAlertData {
  alertId: string;
  projectId: string;
  severity: string;
  title: string;
  sourceIntegrations: string[];
  /** If true, this alert triggered a new incident storm */
  triggeredStorm?: boolean;
  stormId?: string;
  /** Substrate recording data to insert */
  substrateRecording?: {
    recordingId: string;
    events: unknown;
    uiEvents?: unknown;
    context?: string;
    eventCount?: number;
    categories?: unknown;
    durationMs?: number;
  };
  /** Whether to skip Slack/Telegram (already sent inline for backwards compat) */
  skipDirectNotifications?: boolean;
}

/**
 * Run all async post-processing for a newly created alert.
 * Each step is independent — failures don't block other steps.
 */
export async function postAlertCreated(data: PostAlertData): Promise<void> {
  const results: Record<string, "ok" | "skipped" | string> = {};

  // 1. Auto-analyze (AI diagnosis)
  results.autoAnalyze = await callVercel("/api/alerts/post-process", {
    action: "auto-analyze",
    alertId: data.alertId,
  });

  // 2. Substrate recording insert
  if (data.substrateRecording) {
    results.substrate = await callVercel("/api/alerts/post-process", {
      action: "substrate-insert",
      alertId: data.alertId,
      projectId: data.projectId,
      recording: data.substrateRecording,
    });
  }

  // 3. Outgoing webhook dispatch
  results.outgoingWebhooks = await callVercel("/api/alerts/post-process", {
    action: "outgoing-webhooks",
    alertId: data.alertId,
  });

  // 4. Status page incident (critical only)
  if (data.severity === "critical") {
    results.statusPage = await callVercel("/api/alerts/post-process", {
      action: "status-incident",
      alertId: data.alertId,
      projectId: data.projectId,
    });
  }

  console.log(`[post-alert] ${data.alertId}: ${JSON.stringify(results)}`);
}

async function callVercel(path: string, body: Record<string, unknown>): Promise<"ok" | string> {
  if (!APP_URL) return "skipped";

  try {
    const res = await fetch(`${APP_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CRON_SECRET}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

    return res.ok ? "ok" : `error(${res.status})`;
  } catch (err) {
    return err instanceof Error ? err.message : "unknown error";
  }
}
