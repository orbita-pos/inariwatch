import { NextResponse } from "next/server";
import {
  verifySignature,
  loadIntegration,
  createAlertIfNew,
  markIntegrationSuccess,
} from "@/lib/webhooks/shared";
import { checkWebhookRateLimit, extractClientIp } from "@/lib/webhooks/rate-limit";
import { autoAnalyzeAlert } from "@/lib/ai/auto-analyze";
import { db } from "@/lib/db";
import { substrateRecordings } from "@/lib/db/schema";
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

  // Rate limiting
  const ip = extractClientIp(req);
  const rateLimit = await checkWebhookRateLimit(ip);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfter) } }
    );
  }

  const integ = await loadIntegration(integrationId);
  if (!integ) {
    return NextResponse.json({ error: "Integration not found" }, { status: 404 });
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

  // Verify HMAC signature
  const sig = req.headers.get("x-capture-signature") ?? "";
  const sigHex = sig.startsWith("sha256=") ? sig.slice(7) : sig;
  if (!sigHex || !verifySignature(body, sigHex, secret, "sha256")) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
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

  // Build structured context from SDK payload (git, breadcrumbs, env, user, tags)
  const correlationData: Record<string, unknown> = {};
  if (event.git) correlationData.git = event.git;
  if (event.breadcrumbs) correlationData.breadcrumbs = event.breadcrumbs;
  if (event.env) correlationData.env = event.env;
  if (event.user) correlationData.user = event.user;
  if (event.tags) correlationData.tags = event.tags;
  if (event.request) correlationData.request = event.request;

  const result = await createAlertIfNew(
    {
      severity,
      title,
      body: bodyParts.trim(),
      sourceIntegrations: ["capture"],
      fingerprint,
      correlationData: Object.keys(correlationData).length > 0 ? correlationData : undefined,
      isRead: false,
      isResolved: false,
    },
    integ.projectId
  );

  if (result) {
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
          runtime: (event.runtime as string) || "browser",
          startedAt: new Date(),
          eventCount: 0,
          uiEvents: sessionEvents,
        })
        .catch((err) => console.error("[capture-webhook] recording insert failed:", err));
    }
  }

  await markIntegrationSuccess(integrationId);

  return NextResponse.json({ ok: true, alertId: result?.id ?? null });
}
