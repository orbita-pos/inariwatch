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
 * POST /api/webhooks/cloudflare-pages/[integrationId]
 *
 * Receives Cloudflare Pages deployment notifications. Users wire this up via
 * Cloudflare Notifications (Account → Notifications → Pages) which fires
 * on deployment events. Payload shape varies by notification type; we parse
 * both the flat format and the nested `data` object format.
 *
 * Signature verification is optional — if the integration stores a webhook
 * secret, we verify HMAC SHA256 in `X-Webhook-Signature: sha256=<hex>`.
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
  if (integ.service !== "cloudflare-pages") {
    return NextResponse.json({ error: "Not a Cloudflare Pages integration" }, { status: 400 });
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

  // Cloudflare Notifications can send either a flat payload or nested `data`.
  // Handle both shapes.
  const flat = payload as Record<string, unknown>;
  const nested = (payload.data as Record<string, unknown> | undefined) ?? {};
  const get = (key: string): string | undefined => {
    const v = flat[key] ?? nested[key];
    return typeof v === "string" ? v : undefined;
  };

  const deploymentId = get("deployment_id") ?? get("deploymentId");
  const projectName = get("project_name") ?? get("projectName") ?? (config.projectName as string) ?? "cf-pages-project";
  const environment = get("environment");
  const stage = get("stage") ?? (payload.latest_stage as Record<string, string> | undefined)?.name;
  const success = flat.success ?? nested.success;
  const alertType = get("alert_type");
  const commitHash = get("commit_hash") ?? get("commitHash");
  const url = get("url") ?? get("deployment_url");

  const latestStage = payload.latest_stage as Record<string, string> | undefined;
  const isFailure =
    success === false ||
    alertType === "pages_event_alert" ||
    latestStage?.status === "failure";
  const isSuccess =
    success === true ||
    (latestStage?.name === "deploy" && latestStage?.status === "success");

  if (isFailure && environment === "production") {
    const bodyParts = [
      `Project: ${projectName}`,
      deploymentId ? `Deployment ID: ${deploymentId}` : "",
      stage ? `Failed stage: ${stage}` : "",
      commitHash ? `Commit: ${commitHash.slice(0, 8)}` : "",
      url ? `URL: ${url}` : "",
    ].filter(Boolean).join("\n");

    const result = await createAlertIfNew(
      {
        severity: "critical",
        title: `[Cloudflare Pages] Deploy failed — ${projectName}`,
        body: bodyParts,
        sourceIntegrations: ["cloudflare-pages"],
        isRead: false,
        isResolved: false,
      },
      integ.projectId,
    );

    if (result) {
      autoAnalyzeAlert(result).catch(() => {});

      if (autoRollbackEnabled) {
        const token = config.token as string | undefined;
        const accountId = config.accountId as string | undefined;
        if (token && accountId) {
          triggerProviderRollback({
            alertId: result.id,
            projectId: integ.projectId,
            providerConfig: {
              service: "cloudflare-pages",
              token,
              accountId,
              projectName,
            },
          }).catch((e) => console.error("[cloudflare-pages auto-rollback]", e));
        }
      }
    }
  }

  // ── Success on production → schedule 15-min health check ─────────────────
  // CF Pages notifications fire "pages_event_alert" with success=true on deploy.
  // Skip preview deploys — we only monitor production.
  if (isSuccess && environment === "production" && deploymentId) {
    const deployBranch =
      ((payload.deployment_trigger as Record<string, unknown> | undefined)?.metadata as
        | Record<string, unknown>
        | undefined)?.branch as string | undefined;
    scheduleDeployHealthCheck({
      projectId: integ.projectId,
      deploySource: "cloudflare-pages",
      deployId: deploymentId,
      branch: deployBranch ?? "main",
    }).catch(() => {});
  }

  await markIntegrationSuccess(integrationId);
  return NextResponse.json({ ok: true });
}
