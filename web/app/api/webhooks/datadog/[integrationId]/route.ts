import { NextResponse } from "next/server";
import crypto from "crypto";
import {
  loadIntegration,
  createAlertIfNew,
  markIntegrationSuccess,
} from "@/lib/webhooks/shared";
import { checkWebhookRateLimit } from "@/lib/webhooks/rate-limit";
import { autoAnalyzeAlert } from "@/lib/ai/auto-analyze";

/**
 * POST /api/webhooks/datadog/[integrationId]
 *
 * Receives Datadog webhook events from configured monitors.
 *
 * Authentication: Datadog does NOT sign webhooks with HMAC.
 * We require a Bearer token in the Authorization header (or `token` query param)
 * that matches the integration's stored webhookSecret.
 * Users configure this token as a custom header in Datadog webhook settings.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ integrationId: string }> }
) {
  const { integrationId } = await params;

  // Rate limiting
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rateLimit = checkWebhookRateLimit(ip);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfter) } }
    );
  }

  const integ = await loadIntegration(integrationId);
  if (!integ) {
    return NextResponse.json(
      { error: "Integration not found" },
      { status: 404 }
    );
  }

  if (integ.service !== "datadog") {
    return NextResponse.json(
      { error: "Not a Datadog integration" },
      { status: 400 }
    );
  }

  // ── Verify auth token ─────────────────────────────────────────────────
  const secret = integ.webhookSecret;
  if (secret) {
    const authHeader = req.headers.get("authorization") ?? "";
    const url = new URL(req.url);
    const tokenParam = url.searchParams.get("token") ?? "";
    const provided = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : tokenParam;

    if (!provided) {
      return NextResponse.json(
        { error: "Missing authentication token. Set Authorization: Bearer <token> header or ?token= query param." },
        { status: 401 }
      );
    }

    try {
      const ok = crypto.timingSafeEqual(
        Buffer.from(provided),
        Buffer.from(secret)
      );
      if (!ok) {
        return NextResponse.json({ error: "Invalid token" }, { status: 401 });
      }
    } catch {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }
  }

  const body = await req.text();
  if (body.length > 1_000_000) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // ── Parse Datadog webhook payload ────────────────────────────────────
  const alertTitle =
    (payload.title as string) ??
    (payload.alert_title as string) ??
    "Datadog Alert";
  const alertType =
    (payload.alert_type as string) ??
    (payload.event_type as string) ??
    "info";
  const alertBody =
    (payload.body as string) ??
    (payload.event_msg as string) ??
    (payload.text as string) ??
    "";
  const tags = (payload.tags as string) ?? "";
  const link = (payload.link as string) ?? "";
  const hostname = (payload.hostname as string) ?? "";
  const snapshot = (payload.snapshot as string) ?? "";
  const alertStatus =
    (payload.alert_status as string) ??
    (payload.alert_transition as string) ??
    "";

  // Skip "Recovered" / "OK" alerts — these mean the issue resolved itself
  if (
    alertStatus.toLowerCase() === "recovered" ||
    alertStatus.toLowerCase() === "ok"
  ) {
    return NextResponse.json({
      ok: true,
      skipped: "recovered/ok status",
    });
  }

  // Map Datadog alert_type to InariWatch severity
  let severity: "info" | "warning" | "critical" = "warning";
  if (alertType === "error" || alertStatus.toLowerCase() === "alert") {
    severity = "critical";
  } else if (alertType === "warning" || alertType === "warn") {
    severity = "warning";
  }

  // Build the alert body with all available context
  const bodyParts: string[] = [];
  if (alertBody) bodyParts.push(alertBody.slice(0, 1500));
  if (hostname) bodyParts.push(`Host: ${hostname}`);
  if (tags) bodyParts.push(`Tags: ${tags}`);
  if (link) bodyParts.push(`Datadog link: ${link}`);
  if (snapshot) bodyParts.push(`Snapshot: ${snapshot}`);

  let created = 0;

  const result = await createAlertIfNew(
    {
      severity,
      title: `[Datadog] ${alertTitle}`,
      body: bodyParts.join("\n").trim() || "A Datadog monitor triggered an alert.",
      sourceIntegrations: ["datadog"],
      isRead: false,
      isResolved: false,
    },
    integ.projectId
  );

  if (result) {
    created++;
    autoAnalyzeAlert(result).catch(() => {});
  }

  await markIntegrationSuccess(integrationId);

  return NextResponse.json({ ok: true, created });
}
