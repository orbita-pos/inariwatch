import { NextResponse } from "next/server";
import {
  verifySignature,
  loadIntegration,
  loadIntegrationByToken,
  isProjectTokenSecret,
  createAlertIfNew,
  markIntegrationSuccess,
  type CaptureAuthSubject,
} from "@/lib/webhooks/shared";
import {
  isWizardTestEvent,
  markWizardTestEventReceived,
  maybeMarkFirstRealEvent,
} from "@/lib/projects/first-event";
import { resolveRepoFromCaptureEvent } from "@/lib/webhooks/resolve-repo";
import { checkWebhookRateLimit, extractClientIp } from "@/lib/webhooks/rate-limit";
import { rateLimit } from "@/lib/auth-rate-limit";
import { PLAN_LIMITS } from "@/lib/db";
import { autoAnalyzeAlert } from "@/lib/ai/auto-analyze";
import { db, alerts } from "@/lib/db";
import { sql, eq } from "drizzle-orm";
import { substrateRecordings } from "@/lib/db/schema";
import { productMetrics, VAR_EVENTS } from "@/lib/telemetry/product-metrics";
import { extractSessionId } from "@/lib/fulltrace/session-header";
import { assembleCorrelationData } from "@/lib/webhooks/capture-correlation";
import {
  verifyCaptureV2Payload,
  insertCaptureReceipt,
} from "@/lib/services/capture-v2-verify";
import { enrichEventIntentIfMissing } from "@/lib/services/intent-server-enrich";
import {
  hasZeroRetentionHeader,
  processZeroRetention,
} from "@/lib/webhooks/zero-retention";
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

  // Fast-path: reject unsigned probes BEFORE the DB lookup. Two auth modes
  // are accepted (Inari Live V1 — Session 2):
  //
  //   1. Legacy DSN/HMAC: `x-capture-signature: sha256=<hex>` over the body,
  //      keyed on project_integrations.webhook_secret.
  //   2. Project token (new): `Authorization: Bearer iwk_pub_v1_...` looked
  //      up via project_tokens.token_hash. Stateless bearer; no body HMAC.
  //
  // Real callers always send one of these. If neither header is present,
  // the request is invalid without touching the database.
  const sigHeader = req.headers.get("x-capture-signature") ?? "";
  const authHeader = req.headers.get("authorization") ?? "";
  const bearerToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  const hasLegacySig = sigHeader.startsWith("sha256=");
  const hasProjectTokenAuth = isProjectTokenSecret(bearerToken);
  if (!hasLegacySig && !hasProjectTokenAuth) {
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

  // Resolve the auth subject. Prefer token mode when both headers are present
  // (the token is the future-default; the HMAC header is harmless to ignore).
  let subject: CaptureAuthSubject | null = null;
  if (hasProjectTokenAuth) {
    subject = await loadIntegrationByToken(bearerToken);
    if (!subject) {
      return NextResponse.json({ error: "Invalid project token" }, { status: 401 });
    }
    // Defense-in-depth: reject mismatched path → cross-project replay attempts.
    // Token-mode SDKs emit `https://.../capture/<projectId>` so this should
    // always match for a well-behaved client.
    if (subject.projectId !== integrationId) {
      return NextResponse.json({ error: "Token does not match URL project" }, { status: 401 });
    }
  } else {
    const integ = await loadIntegration(integrationId);
    if (!integ) {
      return NextResponse.json({ error: "Integration not found" }, { status: 404 });
    }
    if (integ.service !== "capture") {
      return NextResponse.json({ error: "Not a capture integration" }, { status: 400 });
    }
    if (!integ.webhookSecret) {
      return NextResponse.json({ error: "Webhook not configured" }, { status: 403 });
    }
    subject = {
      projectId:     integ.projectId,
      userPlan:      integ.userPlan,
      integrationId: integ.id,
      webhookSecret: integ.webhookSecret,
      tokenId:       null,
      workspaceId:   null,
      authMode:      "integration",
    };
  }

  // Per-project daily events cap. Counts ALL ingestion sources (capture +
  // sentry + vercel + github + datadog + expo) against the same counter so
  // a noisy app can't bypass by switching sources. Free 50K/day, Pro 500K/day.
  const plan = subject.userPlan ?? "free";
  const dailyCap = (PLAN_LIMITS[plan] ?? PLAN_LIMITS.free).maxCaptureEventsPerDay;
  const dayRl = await rateLimit("capture-daily", subject.projectId, {
    windowMs: 86_400_000,
    max: dailyCap,
  });
  if (!dayRl.allowed) {
    return NextResponse.json(
      { error: "Daily event cap reached for this project" },
      { status: 429, headers: { "Retry-After": String(dayRl.retryAfterSeconds ?? 3600) } }
    );
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

  // Legacy mode requires HMAC verification over the body. Token mode is
  // already authenticated by the bearer lookup — the SHA-256 hash match
  // is the proof of possession.
  if (subject.authMode === "integration") {
    const secret = subject.webhookSecret!;
    const sigHex = sigHeader.slice(7); // strip "sha256=" prefix
    if (!sigHex || !verifySignature(body, sigHex, secret, "sha256")) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Inari Live V1 — Session 3 wizard verification ping. The desktop
  // wizard injects a synthetic event tagged `_inariwatch_test: true`
  // after `npm run dev` boots, to verify the capture pipeline end-to-
  // end. We MUST NOT create an alert row for these (filter-from-
  // dashboard rule per the locked Add-Project flow decision), but we
  // DO mark integration success + transition project state to
  // `verified` so the wizard's SSE stream can dismiss. Branch BEFORE
  // every other path so a malformed test payload doesn't accidentally
  // hit zero-retention / v2 verify / intent enrich.
  if (isWizardTestEvent(event)) {
    if (subject.authMode === "integration" && subject.integrationId) {
      await markIntegrationSuccess(subject.integrationId);
    }
    const ack = `wizard-test-${Date.now()}`;
    await markWizardTestEventReceived(subject.projectId, ack);
    return NextResponse.json({
      ok: true,
      mode: "wizard_test_event",
      ack,
    });
  }

  // Zero-retention mode (Track E pieza 11). When the SDK sets
  // `INARIWATCH_ZERO_RETENTION=true`, every webhook carries
  // `X-IW-Zero-Retention: 1`. We MUST NOT insert into `alerts` — instead
  // run a strict subset (maintenance check, dedup, lightweight notify)
  // and return a signed tombstone receipt the SDK persists locally for
  // audit. Branch BEFORE any DB-writing path.
  if (hasZeroRetentionHeader(req)) {
    const zr = await processZeroRetention({
      integrationId,
      projectId: subject.projectId,
      event,
    });
    if (subject.authMode === "integration" && subject.integrationId) {
      await markIntegrationSuccess(subject.integrationId);
    }
    if (zr.status === "tombstoned") {
      return NextResponse.json({
        ok: true,
        mode: "zero-retention",
        tombstone: zr.tombstone,
        processed_actions: zr.processedActions,
      });
    }
    return NextResponse.json({
      ok: true,
      mode: "zero-retention",
      tombstone: null,
      tombstone_unsigned_reason: zr.reason,
      processed_actions: zr.processedActions,
    });
  }

  // Payload v2 cryptographic verification. Runs ONLY when the SDK explicitly
  // bumped `schema_version` to "2.0". A malformed signature on a v2 payload
  // is logged but doesn't reject the event — backward compat is absolute,
  // and the HMAC over the body (already verified above) provides transport
  // integrity. The Ed25519 signature adds a per-install identity layer that
  // we'll start GATING on in a future phase once every SDK version reports it.
  let v2Verification:
    | { receiptId: string; pubKeyId: string; signerPubkey: string }
    | null = null;
  if (event.schema_version === "2.0") {
    const result = verifyCaptureV2Payload(event);
    if (result.verified) {
      v2Verification = {
        receiptId: result.receiptId,
        pubKeyId: result.pubKeyId,
        signerPubkey: result.signerPubkey,
      };
    } else {
      console.warn(
        JSON.stringify({
          eventname: "capture_v2_verify_failed",
          reason: result.reason,
          integration_id: integrationId,
          fingerprint: event.fingerprint,
        }),
      );
    }
  }

  // Server-side intent enrichment (SKYNET §3 piece 20). When the SDK
  // couldn't compile expected-shape contracts on its own (browser bundle,
  // edge runtime without filesystem, INARIWATCH_INTENT_COMPILER off),
  // fetch the failing file from the linked GitHub repo at the reported
  // commit SHA and run a server-side extractor. Best-effort — never
  // blocks alert creation. Cached in Redis with `(repo, sha, path,
  // symbol)` so retry storms don't pound GitHub. Awaited because intent
  // contracts are part of the alert payload that downstream auto-analyze
  // and remediation read.
  await enrichEventIntentIfMissing(event, subject.projectId).catch((err) =>
    console.warn("[capture-webhook] intent enrich failed:", err),
  );

  // FullTrace correlation id — checked after JSON parse so we can fall back
  // to the event payload when the SDK's fetch interceptor was bypassed.
  // Null = this event is not part of a tracked session (cron jobs, pollers,
  // legacy SDKs). Don't error — just skip correlation.
  const sessionId = extractSessionId(req, event);
  if (sessionId) {
    productMetrics.emit(VAR_EVENTS.SESSION_ID_RECEIVED, {
      organizationId: null,
      valueText: sessionId,
      metadata: { source: "capture_webhook", projectId: subject.projectId },
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

  // Build structured context from SDK payload (v1 + v2 fields). Pulled into
  // a pure helper so the assembly logic can be unit-tested without standing
  // up Next/DB/rate-limiting. See web/lib/webhooks/capture-correlation.ts.
  const correlationData = assembleCorrelationData(event) ?? {};

  // Canonical repo resolution at ingest time (migration 0068). capture
  // v0.10+ SDK sends `git.repo`; older SDK versions still send `git.url`
  // which we parse. If neither is present, remediate.ts will fall back to
  // the project's default_repo.
  const repo = resolveRepoFromCaptureEvent(event as {
    git?: { repo?: unknown; url?: unknown } | null;
    metadata?: { repo?: unknown } | null;
  });

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
      repo,
    },
    subject.projectId
  );

  if (result) {
    if (sessionId) {
      productMetrics.emit(VAR_EVENTS.SESSION_CORRELATED_TO_ALERT, {
        organizationId: null,
        valueText: sessionId,
        metadata: { alertId: result.id, fingerprint, projectId: subject.projectId },
      });
    }

    // Inari Live V1 — Session 3. If this project is mid-wizard and a
    // real (non-test) event just landed, advance to `verified`. Fire-
    // and-forget — failure here should never reject the alert path.
    void maybeMarkFirstRealEvent(subject.projectId, result.id).catch(() => undefined);

    // Persist verified v2 signature into the EAP receipts mirror so it's
    // queryable from /api/eap/verify/:receiptId without rescanning every
    // alert. Idempotent on receiptId — a duplicated event from the same
    // SDK install is a no-op. Fire-and-forget: failure logged, not raised.
    if (v2Verification) {
      const sig = (event.signature as { sig?: string } | undefined)?.sig;
      if (sig) {
        insertCaptureReceipt({
          receiptId: v2Verification.receiptId,
          alertId: result.id,
          signatureHex: sig,
          pubKeyId: v2Verification.pubKeyId,
          signerPubkey: v2Verification.signerPubkey,
        }).catch(() => {});
      }
    }

    autoAnalyzeAlert(result).catch(() => {});

    // Screenshot analysis via Kimi K2.6 (Together AI) — fire-and-forget, 20s timeout.
    // SDK sends `screenshotBase64` when INARIWATCH_SCREENSHOT=true is set.
    // Description is appended to aiReasoning after the AI analysis pass.
    //
    // Upgraded from Qwen2.5-VL-7B-Instruct-Turbo to moonshotai/Kimi-K2.6 on
    // 2026-05-13. Kimi K2.6 is Moonshot's flagship multimodal model
    // ($1.20 input / $4.50 output per M tokens, cached input $0.20). Bigger
    // model, sharper visual reasoning on broken-layout / missing-element /
    // UI-error detection vs the 7B Qwen baseline. Smoke-tested against the
    // image_url+base64 content shape — same wire format, no SDK change needed.
    //
    // TODO(qwen-migration): migrate this to dispatch() from @inariwatch/ai-router
    // once the router gains a vision task type (currently runVision is provider-
    // specific). Tracked separately — the direct fetch here was blocking deploy
    // since 3cfdcd59 (added 2026-05-12) because the lockdown rule
    // `inariwatch/no-direct-ai-sdk-import` matches `api.together.xyz`. ESLint
    // disable below is a deliberate band-aid until the router supports the
    // image_url content shape Together expects.
    const screenshotBase64 = event.screenshotBase64 as string | undefined;
    if (screenshotBase64 && process.env.PLATFORM_TOGETHER_KEY) {
      const alertId = result.id;
      const togetherKey = process.env.PLATFORM_TOGETHER_KEY;
      void (async () => {
        try {
          // eslint-disable-next-line inariwatch/no-direct-ai-sdk-import
          const vlRes = await fetch("https://api.together.xyz/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${togetherKey}`,
            },
            body: JSON.stringify({
              model: "moonshotai/Kimi-K2.6",
              max_tokens: 300,
              messages: [{
                role: "user",
                content: [
                  {
                    type: "image_url",
                    image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` },
                  },
                  {
                    type: "text",
                    text: `Describe any visual errors, broken layouts, missing elements, or UI problems in this screenshot. Context: ${title} (${severity}). Be specific about what is wrong and where. Keep it under 150 words.`,
                  },
                ],
              }],
            }),
            signal: AbortSignal.timeout(20000),
          });
          if (!vlRes.ok) return;
          const vlData = await vlRes.json() as { choices?: { message?: { content?: string } }[] };
          const description = vlData.choices?.[0]?.message?.content?.trim();
          if (description) {
            await db
              .update(alerts)
              .set({
                aiReasoning: sql`COALESCE(${alerts.aiReasoning}, '') || ${"\n\n[Screenshot Analysis] " + description}`,
              })
              .where(eq(alerts.id, alertId));
          }
        } catch {
          // Never block alert creation on screenshot analysis failure
        }
      })();
    }

    // Save inline session recording (rrweb) linked to this specific alert
    const sessionEvents = (event.sessionEvents as unknown[] | undefined)?.slice(0, 5000);
    if (sessionEvents?.length) {
      const recordingId = crypto.randomUUID();
      await db.insert(substrateRecordings)
        .values({
          recordingId,
          alertId: result.id,
          projectId: subject.projectId,
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
          projectId: subject.projectId,
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
          metadata: { alertId: result.id, recordingId, projectId: subject.projectId },
        });
      }
    }
  }

  // Legacy integrations track success via project_integrations.last_success_at;
  // token-mode subjects already bumped project_tokens.last_used_at inside the
  // bearer lookup, so there's nothing to mark here.
  if (subject.authMode === "integration" && subject.integrationId) {
    await markIntegrationSuccess(subject.integrationId);
  }

  return NextResponse.json({ ok: true, alertId: result?.id ?? null });
}
