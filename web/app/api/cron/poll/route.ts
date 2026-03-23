import { NextResponse } from "next/server";
import { db, alerts, projectIntegrations, projects } from "@/lib/db";
import { eq, and, gt } from "drizzle-orm";
import { processNotificationQueue, processEmailDigests } from "@/lib/notifications/send";
import { createAlertIfNew } from "@/lib/webhooks/shared";
import { correlateProjectAlerts } from "@/lib/ai/correlate";
import { runAnomalyEngine } from "@/lib/pollers/anomaly";
import type { Alert } from "@/lib/db";

import crypto from "crypto";
import { cronLog, pingCronHealth } from "@/lib/cron-utils";

const CRON_SECRET = process.env.CRON_SECRET;
const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

const SUB_ROUTES = [
  "github",
  "vercel",
  "sentry",
  "uptime",
  "postgres",
  "npm",
] as const;

type SubRouteResult = { ok: boolean; created: number; errors: string[] };

export async function GET(req: Request) {
  const start = Date.now();

  // Verify secret — fail closed (reject if secret is unset)
  const auth = req.headers.get("authorization");
  if (!CRON_SECRET || !auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const expected = Buffer.from(`Bearer ${CRON_SECRET}`);
  const actual = Buffer.from(auth);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── 1. Fan out to all per-service sub-routes in parallel ──────────────────
  const fanOutStart = Date.now();
  const fetchResults = await Promise.allSettled(
    SUB_ROUTES.map((service) =>
      fetch(`${APP_URL}/api/cron/poll/${service}`, {
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      }).then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => res.statusText);
          throw new Error(`HTTP ${res.status}: ${text}`);
        }
        return res.json() as Promise<SubRouteResult>;
      })
    )
  );

  let totalCreated = 0;
  const allErrors: string[] = [];
  const subRouteResults: Record<string, SubRouteResult | { error: string }> = {};

  for (let i = 0; i < fetchResults.length; i++) {
    const service = SUB_ROUTES[i];
    const result = fetchResults[i];
    if (result.status === "fulfilled") {
      subRouteResults[service] = result.value;
      totalCreated += result.value.created ?? 0;
      for (const err of result.value.errors ?? []) {
        allErrors.push(err);
      }
    } else {
      const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      allErrors.push(`sub-route/${service}: ${errMsg}`);
      subRouteResults[service] = { error: errMsg };
    }
  }
  const fanOutDuration = Date.now() - fanOutStart;

  // ── 2. AI correlation — query alerts created in the last 2 minutes ────────
  const correlationWindow = new Date(Date.now() - 2 * 60 * 1000);
  try {
    const recentAlerts = await db
      .select()
      .from(alerts)
      .where(gt(alerts.createdAt, correlationWindow));

    // Group by project
    const byProject = new Map<string, Alert[]>();
    for (const alert of recentAlerts) {
      const group = byProject.get(alert.projectId) ?? [];
      group.push(alert as Alert);
      byProject.set(alert.projectId, group);
    }

    for (const [projectId, projectAlerts] of byProject.entries()) {
      if (projectAlerts.length >= 2) {
        correlateProjectAlerts(projectAlerts, projectId).catch(() => {});
      }
    }
  } catch {
    // Correlation failure must not break the cron response
  }

  // ── 3. Anomaly detection across all active projects ───────────────────────
  try {
    const activeProjects = await db
      .select({ projectId: projectIntegrations.projectId })
      .from(projectIntegrations)
      .where(eq(projectIntegrations.isActive, true));

    const allProjectIds = [...new Set(activeProjects.map((r) => r.projectId))];
    const anomalies = await runAnomalyEngine(allProjectIds);

    for (const anomaly of anomalies) {
      const { projectId, ...alert } = anomaly;
      const result = await createAlertIfNew(alert, projectId);
      if (result) totalCreated++;
    }
  } catch {
    // Anomaly detection failure must not break the cron response
  }

  // ── 4. Process notification queue and email digests ───────────────────────
  let notifyResult = { sent: 0, failed: 0, skipped: 0 };
  let digestResult = { sent: 0, failed: 0 };
  try {
    notifyResult = await processNotificationQueue();
  } catch {
    // Queue processing failure must not break the cron response
  }
  try {
    digestResult = await processEmailDigests();
  } catch {
    // Digest processing failure must not break the cron response
  }

  const duration_ms = Date.now() - start;
  cronLog("poll", {
    created: totalCreated,
    fan_out_duration_ms: fanOutDuration,
    sub_routes: subRouteResults,
    notifications_sent: notifyResult.sent,
    notifications_failed: notifyResult.failed,
    digests_sent: digestResult.sent,
    errors: allErrors.length,
    duration_ms,
  });
  await pingCronHealth("poll", allErrors.length === 0);

  return NextResponse.json({
    ok: true,
    created: totalCreated,
    sub_routes: subRouteResults,
    notifications: notifyResult,
    digests: digestResult,
    errors: allErrors,
  });
}
