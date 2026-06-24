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
 * POST /api/webhooks/netlify/[integrationId]
 *
 * Receives Netlify deploy webhook events. Netlify's webhook UI lets users
 * configure a JSON POST to be sent on deploy status changes. We ingest:
 *  - deploy_failed → critical alert + optional auto-rollback
 *  - deploy_building / deploy_ready → markers for deploy monitoring
 *
 * Netlify supports signing webhooks via a shared secret (HMAC SHA256, sent
 * in the `X-Webhook-Signature` header as `sha256=<hex>`). If the user
 * configured a webhook secret in the integration, we verify; otherwise we
 * accept the payload (logged for audit).
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
  if (!integ) {
    return NextResponse.json({ error: "Integration not found" }, { status: 404 });
  }

  if (integ.service !== "netlify") {
    return NextResponse.json({ error: "Not a Netlify integration" }, { status: 400 });
  }

  // Daily events cap per project.
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

  // Optional signature verification — only if the integration has a secret.
  if (integ.webhookSecret) {
    const sigHeader = req.headers.get("x-webhook-signature") ?? "";
    const expectedHex = createHmac("sha256", integ.webhookSecret).update(body, "utf8").digest("hex");
    const expected = `sha256=${expectedHex}`;
    try {
      const a = Buffer.from(sigHeader);
      const b = Buffer.from(expected);
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

  const state = payload.state as string | undefined;
  const siteName = (payload.name as string) ?? (payload.site_name as string) ?? "netlify-site";
  const deployId = payload.id as string | undefined;
  const errorMessage = (payload.error_message as string) ?? "";
  const commitRef = (payload.commit_ref as string) ?? "";
  const branch = (payload.branch as string) ?? "";
  const deployUrl = (payload.ssl_url as string) ?? (payload.deploy_ssl_url as string) ?? (payload.deploy_url as string) ?? "";

  // ── deploy_failed / error / building_failed → critical alert + auto-rollback ──
  if (state === "error" || state === "building_failed" || state === "deploy_failed") {
    const bodyParts = [
      `State: ${state}`,
      `Site: ${siteName}`,
      deployId ? `Deploy ID: ${deployId}` : "",
      branch ? `Branch: ${branch}` : "",
      commitRef ? `Commit: ${commitRef.slice(0, 8)}` : "",
      deployUrl ? `URL: ${deployUrl}` : "",
      errorMessage ? `\nError:\n${errorMessage.slice(0, 4000)}` : "",
    ].filter(Boolean).join("\n");

    const result = await createAlertIfNew(
      {
        severity: "critical",
        title: `[Netlify] Deploy failed — ${siteName}`,
        body: bodyParts,
        sourceIntegrations: ["netlify"],
        isRead: false,
        isResolved: false,
      },
      integ.projectId,
    );

    if (result) {
      autoAnalyzeAlert(result).catch(() => {});

      if (autoRollbackEnabled) {
        const token = config.token as string | undefined;
        const siteId = config.siteId as string | undefined;
        if (token && siteId) {
          triggerProviderRollback({
            alertId: result.id,
            projectId: integ.projectId,
            providerConfig: {
              service: "netlify",
              token,
              siteId,
              projectName: siteName,
            },
          }).catch((e) => console.error("[netlify auto-rollback]", e));
        }
      }
    }
  }

  // ── state === "ready" → successful production deploy, schedule 15-min check ──
  // Netlify uses "ready" for successful deploys. Skip deploy-previews.
  const netlifyContext = (payload.context as string | undefined) ?? "production";
  if (state === "ready" && netlifyContext === "production" && deployId) {
    scheduleDeployHealthCheck({
      projectId: integ.projectId,
      deploySource: "netlify",
      deployId,
      branch: branch || "main",
    }).catch(() => {});
  }

  await markIntegrationSuccess(integrationId);
  return NextResponse.json({ ok: true });
}
