import { NextRequest, NextResponse } from "next/server";
import { createAlertIfNew, loadIntegration, markIntegrationSuccess } from "@/lib/webhooks/shared";
import { rateLimit } from "@/lib/auth-rate-limit";
import { autoAnalyzeAlert } from "@/lib/ai/auto-analyze";
import crypto from "crypto";

/**
 * POST /api/webhooks/expo/[integrationId]
 * Receives webhook events from Expo (EAS Build, EAS Update).
 * Expo webhooks use HMAC-SHA1 signing via expo-webhook-secret header.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ integrationId: string }> }
) {
  const { integrationId } = await params;

  // Validate UUID format
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(integrationId)) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  // Rate limit
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rl = await rateLimit("webhook-expo", ip, { windowMs: 60_000, max: 60 });
  if (!rl.allowed) {
    return NextResponse.json({ error: "Rate limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds ?? 60) } });
  }

  // Load integration
  const integ = await loadIntegration(integrationId);
  if (!integ) return NextResponse.json({ error: "Integration not found" }, { status: 404 });
  if (integ.service !== "expo") return NextResponse.json({ error: "Not an Expo integration" }, { status: 400 });

  // Require webhook secret — reject if not configured
  const secret = integ.webhookSecret;
  if (!secret) return NextResponse.json({ error: "Webhook not configured" }, { status: 403 });

  // Size limit (check Content-Length first to avoid reading large payloads)
  const contentLength = parseInt(req.headers.get("content-length") ?? "0", 10);
  if (contentLength > 1_000_000) return NextResponse.json({ error: "Payload too large" }, { status: 413 });

  const body = await req.text();
  if (body.length > 1_000_000) return NextResponse.json({ error: "Payload too large" }, { status: 413 });

  // Verify HMAC-SHA256 signature (timing-safe)
  const sig = req.headers.get("expo-signature") ?? req.headers.get("x-expo-signature") ?? "";
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
  if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Parse payload
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  let created = 0;

  // EAS Build webhook events
  const buildStatus = payload.status as string | undefined;
  const buildPlatform = payload.platform as string | undefined;
  const buildId = payload.id as string | undefined;
  const appName = (payload.appName as string) ?? (payload.projectName as string) ?? "unknown";

  if (buildStatus === "errored" || buildStatus === "canceled") {
    const errorMsg = (payload.error as { message?: string })?.message ?? "Build failed";

    const result = await createAlertIfNew(
      {
        severity: "critical",
        title: `EAS Build failed: ${appName} (${buildPlatform ?? "unknown"})`,
        body: [
          `Build ${buildId ?? "unknown"} for ${appName} failed.`,
          `Platform: ${buildPlatform ?? "unknown"}`,
          `Status: ${buildStatus}`,
          `Error: ${errorMsg}`,
        ].join("\n"),
        sourceIntegrations: ["expo"],
        isRead: false,
        isResolved: false,
      },
      integ.projectId
    );

    if (result) {
      created++;
      autoAnalyzeAlert(result).catch(() => {});
    }
  }

  // EAS Update webhook events
  if (payload.type === "update" && payload.event === "rollback") {
    const result = await createAlertIfNew(
      {
        severity: "warning",
        title: `EAS Update rolled back: ${appName}`,
        body: `An OTA update for ${appName} was rolled back to the embedded version.`,
        sourceIntegrations: ["expo"],
        isRead: false,
        isResolved: false,
      },
      integ.projectId
    );

    if (result) {
      created++;
      autoAnalyzeAlert(result).catch(() => {});
    }
  }

  await markIntegrationSuccess(integrationId);

  return NextResponse.json({ ok: true, created });
}
