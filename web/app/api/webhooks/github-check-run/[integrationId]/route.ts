/**
 * Fase 4 — GitHub check_run.completed webhook for remediation CI monitoring.
 *
 * POST /api/webhooks/github-check-run/[integrationId]
 *
 * Dedicated endpoint for the remediation pipeline's CI listener. Separate
 * from /api/webhooks/github/[integrationId] (which creates alerts on CI
 * failure) so operators can enable/disable webhook-driven CI monitoring
 * independently of alert-creation subscriptions.
 *
 * Flow:
 *   1. Verify HMAC-SHA256 signature using the integration's stored secret
 *   2. Only react to `check_run` events with action=completed
 *   3. Resolve head_sha → sessionId via Redis (set by remediate.ts before
 *      it starts waiting for CI)
 *   4. Publish a normalized payload to remediation:<sessionId>:ci so the
 *      listener in remediate.ts unblocks immediately
 *
 * Auth model: signature verification is the authority. The remediation
 * listener, on receiving a wake, re-queries the GitHub API to confirm the
 * real CI conclusion — this endpoint is only a wake signal, not a source
 * of truth. See SECURITY_AND_COMPLIANCE_ROADMAP.md §1 threat model for the
 * justification.
 */

import { NextResponse } from "next/server";
import {
  verifySignature,
  loadIntegration,
  markIntegrationSuccess,
} from "@/lib/webhooks/shared";
import { checkWebhookRateLimit, extractClientIp } from "@/lib/webhooks/rate-limit";
import { publishCiCompletion, isCiWebhookEnabled } from "@/lib/ai/ci-webhook";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 1_000_000;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ integrationId: string }> },
) {
  const { integrationId } = await params;

  if (!UUID_RE.test(integrationId)) {
    return NextResponse.json({ error: "Invalid integration ID" }, { status: 400 });
  }

  // Short-circuit when the feature is off. Do this AFTER param validation
  // so malformed requests still get a fast 400 response, and BEFORE any
  // DB/Redis work so disabling the flag drops to near-zero overhead.
  if (!isCiWebhookEnabled()) {
    return NextResponse.json({ ok: true, skipped: "CI_WEBHOOK_MODE disabled" });
  }

  // IP rate limit — same DB-backed limiter as the main GitHub webhook.
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
  if (integ.service !== "github") {
    return NextResponse.json({ error: "Not a GitHub integration" }, { status: 400 });
  }

  const secret = integ.webhookSecret;
  if (!secret) {
    return NextResponse.json({ error: "Webhook not configured" }, { status: 403 });
  }

  const body = await req.text();
  if (body.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  const sigHeader = req.headers.get("x-hub-signature-256") ?? "";
  const sig = sigHeader.replace("sha256=", "");
  if (!sig || !verifySignature(body, sig, secret, "sha256")) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const event = req.headers.get("x-github-event") ?? "";
  if (event !== "check_run") {
    // Any other event is a subscription misconfiguration — accept without
    // processing so GitHub doesn't flood us with retries.
    return NextResponse.json({ ok: true, skipped: `event=${event}` });
  }

  let payload: GitHubCheckRunEvent;
  try {
    payload = JSON.parse(body) as GitHubCheckRunEvent;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (payload.action !== "completed") {
    return NextResponse.json({ ok: true, skipped: `action=${payload.action}` });
  }

  const checkRun = payload.check_run;
  const headSha = checkRun?.head_sha;
  if (typeof headSha !== "string" || headSha.length < 7) {
    return NextResponse.json({ error: "Missing head_sha" }, { status: 400 });
  }

  const conclusion = typeof checkRun?.conclusion === "string" ? checkRun.conclusion : "unknown";
  const deliveryId = req.headers.get("x-github-delivery");
  const checkRunId = typeof checkRun?.id === "number" ? checkRun.id : null;

  const publishResult = await publishCiCompletion(headSha, {
    conclusion,
    deliveryId: deliveryId ?? null,
    checkRunId,
  });

  await markIntegrationSuccess(integrationId);

  if (!publishResult) {
    // head_sha not associated with a remediation — this is the normal case
    // for non-remediation pushes. Return success so GitHub doesn't retry.
    return NextResponse.json({ ok: true, matched: false });
  }

  return NextResponse.json({
    ok: true,
    matched: true,
    sessionId: publishResult.sessionId,
    subscribers: publishResult.subscribers,
  });
}

// ── Payload shape ──────────────────────────────────────────────────────────

interface GitHubCheckRunEvent {
  action?: string;
  check_run?: {
    id?: number;
    head_sha?: string;
    conclusion?: string | null;
    status?: string;
    name?: string;
  };
}
