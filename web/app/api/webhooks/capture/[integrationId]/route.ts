import { NextResponse } from "next/server";
import {
  verifySignature,
  loadIntegration,
  createAlertIfNew,
  markIntegrationSuccess,
} from "@/lib/webhooks/shared";
import { checkWebhookRateLimit, extractClientIp } from "@/lib/webhooks/rate-limit";
import { rateLimit } from "@/lib/auth-rate-limit";
import { PLAN_LIMITS } from "@/lib/db";
import { autoAnalyzeAlert } from "@/lib/ai/auto-analyze";
import { db } from "@/lib/db";
import { substrateRecordings } from "@/lib/db/schema";
import { productMetrics, VAR_EVENTS } from "@/lib/telemetry/product-metrics";
import { extractSessionId } from "@/lib/fulltrace/session-header";
import crypto from "crypto";

/**
 * POST /api/webhooks/capture/[integrationId]
 *
 * Receives error events from the @inariwatch/capture SDK.
 * Replaces Sentry for direct error capture — sub-second latency.
 *
 * Headers:
 * - x-capture-signature: "sha256=<hex>" (HMAC-SHA256 of body)
 *
 * Body (JSON):
 * - fingerprint: string (SHA-256 of normalized error)
 * - title: string (e.g. "TypeError: Cannot read properties of undefined")
 * - body: string (full stack trace + context)
 * - severity: "critical" | "warning" | "info"
 * - timestamp: string (ISO 8601)
 * - environment?: string
 * - release?: string
 * - request?: { method, url }
 * - runtime?: "nodejs" | "edge"
 * - routePath?: string
 * - routeType?: string
 * - context?: Record<string, unknown>
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ integrationId: string }> }
) {
  const { integrationId } = await params;

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(integrationId))
    return NextResponse.json({ error: "Invalid integration ID" }, { status: 400 });

  // Fast-path: reject unsigned probes BEFORE the DB lookup. This saves
  // a `loadIntegration` round-trip on every unauthenticated request.
  // Real callers always send `x-capture-signature`; if the header is
  // missing or malformed, we know the request is invalid without touching
  // the database.
  const sigHeader = req.headers.get("x-capture-signature") ?? "";
  if (!sigHeader || !sigHeader.startsWith("sha256=")) {
    return NextResponse.json({ error: "Missing or invalid signature header" }, { status: 401 });
  }

  // IP rate limiting (anti-DOS)
  const ip = extractClientIp(req);
  const ipRl = await checkWebhookRateLimit(ip);
  if (!ipRl.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(ipRl.retryAfter) } }
    );
  }

  const integ = await loadIntegration(integrationId);
  if (!integ) {
    return NextResponse.json({ error: "Integration not found" }, { status: 404 });
  }

  // Per-project daily events cap. Counts ALL ingestion sources (capture +
  // sentry + vercel + github + datadog + expo) against the same counter so
  // a noisy app can't bypass by switching sources. Free 50K/day, Pro 500K/day.
  const plan = integ.userPlan ?? "free";
  const dailyCap = (PLAN_LIMITS[plan] ?? PLAN_LIMITS.free).maxCaptureEventsPerDay;
  const dayRl = await rateLimit("capture-daily", integ.projectId, {
    windowMs: 86_400_000,
    max: dailyCap,
  });
  if (!dayRl.allowed) {
    return NextResponse.json(
      { error: "Daily event cap reached for this project" },
      { status: 429, headers: { "Retry-After": String(dayRl.retryAfterSeconds ?? 3600) } }
    );
  }

  if (integ.service !== "capture") {
    return NextResponse.json({ error: "Not a capture integration" }, { status: 400 });
  }

  const secret = integ.webhookSecret;
  if (!secret) {
    return NextResponse.json({ error: "Webhook not configured" }, { status: 403 });
  }

  // Pre-check Content-Length header before reading body into memory
  const contentLength = parseInt(req.headers.get("content-length") ?? "0", 10);
  if (contentLength > 200_000) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  const body = await req.text();
  if (body.length > 200_000) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  // Verify HMAC signature (header existence already checked above as fast-path)
  const sigHex = sigHeader.slice(7); // strip "sha256=" prefix
  if (!sigHex || !verifySignature(body, sigHex, secret, "sha256")) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // FullTrace correlation id — checked after JSON parse so we can fall back
  // to the event payload when the SDK's fetch interceptor was bypassed.
  // Null = this event is not part of a tracked session (cron jobs, pollers,
  // legacy SDKs). Don't error — just skip correlation.
  const sessionId = extractSessionId(req, event);
  if (sessionId) {
    productMetrics.emit(VAR_EVENTS.SESSION_ID_RECEIVED, {
      organizationId: null,
      valueText: sessionId,
      metadata: { source: "capture_webhook", projectId: integ.projectId },
    });
  }

  const title = (event.title as string) || "Captured error";
  const VALID_SEVERITIES = new Set(["critical", "warning", "info"]);
  const severity = VALID_SEVERITIES.has(event.severity as string)
    ? (event.severity as "critical" | "warning" | "info")
    : "critical";
  const fingerprint = (event.fingerprint as string) || undefined;

  // Build alert body from event context
  const bodyParts = [
    event.body as string || "",
    event.request ? `Request: ${(event.request as { method?: string }).method} ${(event.request as { url?: string }).url}` : "",
    event.runtime ? `Runtime: ${event.runtime}` : "",
    event.routePath ? `Route: ${event.routePath} (${event.routeType || "unknown"})` : "",
    event.environment ? `Environment: ${event.environment}` : "",
    event.release ? `Release: ${event.release}` : "",
  ].filter(Boolean).join("\n");

  // Determine alert type from event (error, security, log)
  const eventType = event.eventType as string | undefined;
  const alertType = eventType === "security" ? "security" : eventType === "log" ? "log" : "error";

  // Build structured context from SDK payload (git, breadcrumbs, env, user, tags, securityContext)
  const correlationData: Record<string, unknown> = {};
  if (event.git) correlationData.git = event.git;
  if (event.breadcrumbs) correlationData.breadcrumbs = event.breadcrumbs;
  if (event.env) correlationData.env = event.env;
  if (event.user) correlationData.user = event.user;
  if (event.tags) correlationData.tags = event.tags;
  if (event.request) correlationData.request = event.request;
  const ctx = event.context as Record<string, unknown> | undefined;
  if (ctx?.securityContext) correlationData.securityContext = ctx.securityContext;

  const result = await createAlertIfNew(
    {
      severity,
      title,
      body: bodyParts.trim(),
      sourceIntegrations: ["capture"],
      alertType,
      fingerprint,
      correlationData: Object.keys(correlationData).length > 0 ? correlationData : undefined,
      isRead: false,
      isResolved: false,
      sessionId,
    },
    integ.projectId
  );

  if (result) {
    if (sessionId) {
      productMetrics.emit(VAR_EVENTS.SESSION_CORRELATED_TO_ALERT, {
        organizationId: null,
        valueText: sessionId,
        metadata: { alertId: result.id, fingerprint, projectId: integ.projectId },
      });
    }

    autoAnalyzeAlert(result).catch(() => {});

    // Save inline session recording (rrweb) linked to this specific alert
    const sessionEvents = (event.sessionEvents as unknown[] | undefined)?.slice(0, 5000);
    if (sessionEvents?.length) {
      const recordingId = crypto.randomUUID();
      await db.insert(substrateRecordings)
        .values({
          recordingId,
          alertId: result.id,
          projectId: integ.projectId,
          sessionId,
          runtime: (event.runtime as string) || "browser",
          startedAt: new Date(),
          eventCount: 0,
          uiEvents: sessionEvents,
        })
        .catch((err) => console.error("[capture-webhook] recording insert failed:", err));
    }

    // Save inline Substrate I/O recording linked to this specific alert
    const substrateEvents = (event.substrateEvents as unknown[] | undefined)?.slice(0, 5000);
    if (substrateEvents?.length) {
      const recordingId = crypto.randomUUID();
      await db.insert(substrateRecordings)
        .values({
          recordingId,
          alertId: result.id,
          projectId: integ.projectId,
          sessionId,
          runtime: (event.runtime as string) || "node",
          startedAt: new Date(),
          eventCount: substrateEvents.length,
          events: substrateEvents,
        })
        .catch((err) => console.error("[capture-webhook] substrate recording insert failed:", err));
      if (sessionId) {
        productMetrics.emit(VAR_EVENTS.SESSION_CORRELATED_TO_SUBSTRATE, {
          organizationId: null,
          valueText: sessionId,
          metadata: { alertId: result.id, recordingId, projectId: integ.projectId },
        });
      }
    }
  }

  await markIntegrationSuccess(integrationId);

  return NextResponse.json({ ok: true, alertId: result?.id ?? null });
}
