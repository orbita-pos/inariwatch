import { NextResponse } from "next/server";
import {
  verifySignature,
  loadIntegration,
  createAlertIfNew,
  markIntegrationSuccess,
} from "@/lib/webhooks/shared";
import { checkWebhookRateLimit } from "@/lib/webhooks/rate-limit";
import { autoAnalyzeAlert } from "@/lib/ai/auto-analyze";

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

  // Rate limiting
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
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
  const severity = (event.severity as "critical" | "warning" | "info") || "critical";
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

  const result = await createAlertIfNew(
    {
      severity,
      title,
      body: bodyParts.trim(),
      sourceIntegrations: ["capture"],
      fingerprint,
      isRead: false,
      isResolved: false,
    },
    integ.projectId
  );

  if (result) {
    autoAnalyzeAlert(result).catch(() => {});
  }

  await markIntegrationSuccess(integrationId);

  return NextResponse.json({ ok: true, alertId: result?.id ?? null });
}
