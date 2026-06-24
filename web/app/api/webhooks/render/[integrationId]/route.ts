import { NextResponse } from "next/server";
import {
  loadIntegration,
  createAlertIfNew,
  markIntegrationSuccess,
} from "@/lib/webhooks/shared";
import { checkWebhookRateLimit, extractClientIp } from "@/lib/webhooks/rate-limit";
import { rateLimit } from "@/lib/auth-rate-limit";
import { PLAN_LIMITS } from "@/lib/db";
import { decryptConfig } from "@/lib/crypto";
import { autoAnalyzeAlert } from "@/lib/ai/auto-analyze";
import { triggerProviderRollback } from "@/lib/services/auto-rollback";
import { scheduleDeployHealthCheck } from "@/lib/services/deploy-health-check";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * POST /api/webhooks/render/[integrationId]
 *
 * Receives Render webhook events. Render's webhook format (per their docs
 * at render.com/docs/webhooks) wraps event data in a `data` object:
 *
 *   { type: "deploy.failed",
 *     timestamp: "...",
 *     data: { id, serviceId, deployId } }
 *
 * Relevant event types we ingest as critical alerts:
 *  - deploy.failed
 *  - server.unavailable
 *
 * Render signs webhooks with HMAC SHA256 in `render-webhook-signature` header.
 * We accept both that header and the generic `x-webhook-signature` shape.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ integrationId: string }> },
) {
  const { integrationId } = await params;

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(integrationId)) {
    return NextResponse.json({ error: "Invalid integration ID" }, { status: 400 });
  }

  const ip = extractClientIp(req);
  const ipRl = await checkWebhookRateLimit(ip);
  if (!ipRl.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(ipRl.retryAfter) } },
    );
  }

  const integ = await loadIntegration(integrationId);
  if (!integ) return NextResponse.json({ error: "Integration not found" }, { status: 404 });
  if (integ.service !== "render") {
    return NextResponse.json({ error: "Not a Render integration" }, { status: 400 });
  }

  const plan = integ.userPlan ?? "free";
  const dailyCap = (PLAN_LIMITS[plan] ?? PLAN_LIMITS.free).maxCaptureEventsPerDay;
  const dayRl = await rateLimit("capture-daily", integ.projectId, {
    windowMs: 86_400_000,
    max: dailyCap,
  });
  if (!dayRl.allowed) {
    return NextResponse.json(
      { error: "Daily event cap reached for this project" },
      { status: 429, headers: { "Retry-After": String(dayRl.retryAfterSeconds ?? 3600) } },
    );
  }

  const body = await req.text();
  if (body.length > 1_000_000) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  if (integ.webhookSecret) {
    const sigHeader =
      req.headers.get("render-webhook-signature") ??
      req.headers.get("x-webhook-signature") ??
      "";
    const expectedHex = createHmac("sha256", integ.webhookSecret).update(body, "utf8").digest("hex");
    const expected = `sha256=${expectedHex}`;
    const expectedBare = expectedHex;
    try {
      const a = Buffer.from(sigHeader);
      const b = Buffer.from(sigHeader.startsWith("sha256=") ? expected : expectedBare);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
      }
    } catch {
      return NextResponse.json({ error: "Invalid signature format" }, { status: 401 });
    }
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const config = decryptConfig(integ.configEncrypted);
  const rawAlertConfig = config.alertConfig as Record<string, unknown> | undefined;
  const autoRollbackEnabled = rawAlertConfig?.autoRollback === true;

  const type = payload.type as string | undefined;
  const data = (payload.data as Record<string, unknown> | undefined) ?? {};
  const eventServiceId = (data.serviceId as string | undefined) ?? (payload.serviceId as string | undefined);
  const deployId = (data.deployId as string | undefined) ?? (payload.deployId as string | undefined);

  // Only the current integration's service should trigger alerts.
  const configServiceId = config.serviceId as string | undefined;
  if (configServiceId && eventServiceId && eventServiceId !== configServiceId) {
    // Webhook landed on the wrong integration — acknowledge without alert.
    await markIntegrationSuccess(integrationId);
    return NextResponse.json({ ok: true, skipped: "service-id-mismatch" });
  }

  const projectName = (config.projectName as string) ?? "render-service";

  const isFailure =
    type === "deploy.failed" ||
    type === "server.unavailable" ||
    type === "deploy.canceled";

  if (isFailure) {
    const bodyParts = [
      `Service: ${projectName}`,
      type ? `Event: ${type}` : "",
      deployId ? `Deploy ID: ${deployId}` : "",
      eventServiceId ? `Render service ID: ${eventServiceId}` : "",
    ].filter(Boolean).join("\n");

    const result = await createAlertIfNew(
      {
        severity: type === "server.unavailable" ? "critical" : "critical",
        title: `[Render] ${type === "server.unavailable" ? "Service down" : "Deploy failed"} — ${projectName}`,
        body: bodyParts,
        sourceIntegrations: ["render"],
        isRead: false,
        isResolved: false,
      },
      integ.projectId,
    );

    if (result) {
      autoAnalyzeAlert(result).catch(() => {});

      if (autoRollbackEnabled && type === "deploy.failed") {
        const token = config.token as string | undefined;
        const serviceId = config.serviceId as string | undefined;
        if (token && serviceId) {
          triggerProviderRollback({
            alertId: result.id,
            projectId: integ.projectId,
            providerConfig: {
              service: "render",
              token,
              serviceId,
              projectName,
            },
          }).catch((e) => console.error("[render auto-rollback]", e));
        }
      }
    }
  }

  // ── deploy.succeeded → schedule 15-min health check ─────────────────────
  if (type === "deploy.succeeded" && deployId) {
    scheduleDeployHealthCheck({
      projectId: integ.projectId,
      deploySource: "render",
      deployId,
      branch: "main", // Render webhook payload doesn't include branch; fallback.
    }).catch(() => {});
  }

  await markIntegrationSuccess(integrationId);
  return NextResponse.json({ ok: true });
}
