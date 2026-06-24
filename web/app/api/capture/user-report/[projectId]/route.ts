/**
 * POST /api/capture/user-report/[projectId]
 *
 * User-initiated "report visual bug" submissions from `@inariwatch/capture`'s
 * `/visual-report` module. The SDK widget captures a screenshot + a rich
 * context bundle (DOM, React fiber state, console + network rings, user
 * events, perf, source-map build_id, redaction stats) and POSTs the whole
 * package here.
 *
 * Distinct from /api/webhooks/capture/[integrationId]:
 *   - This is INTENT-driven (user clicked "report"). The capture webhook
 *     is INCIDENT-driven (an exception was thrown).
 *   - This stores the full bundle in `visual_reports.bundleJson` for the
 *     AI diagnosis pipeline (Phase 3). The capture webhook stores only
 *     the alert summary + optional fire-and-forget Kimi screenshot blurb.
 *   - This always creates an alert with `source_integrations: ["user_report"]`.
 *
 * Auth: Bearer `iwk_pub_v1_…` project token (the same token shipped to the
 * customer's app via the Add-Project wizard for the auto-capture webhook).
 * The token's projectId must match the URL.
 *
 * Body (JSON, ≤500KB):
 *   {
 *     screenshot:     "data:image/webp;base64,…",   // required
 *     bundle:         { … },                         // required (capture context)
 *     description?:   "modal won't close on outside click",
 *     captureMs?:     142,
 *     payloadSize?:   118_443,
 *     redactionStats?: { emails: 2, tokens: 0, … },
 *     sessionId?:     "ses_…"                        // X-IW-Session-Id correlation
 *   }
 *
 * Response:
 *   200 — { ok, reportId, alertId, bundleHash, deduped }
 *   400 — invalid project ID, malformed body
 *   401 — missing/invalid bearer
 *   413 — payload too large
 *   429 — rate-limited
 *   503 — maintenance window (rare; same path the capture webhook takes)
 */

import { NextResponse } from "next/server";
import {
  loadIntegrationByToken,
  isProjectTokenSecret,
} from "@/lib/webhooks/shared";
import { extractClientIp, checkWebhookRateLimit } from "@/lib/webhooks/rate-limit";
import { rateLimit } from "@/lib/auth-rate-limit";
import { createVisualReport } from "@/lib/services/visual-reports.service";
import { extractSessionId } from "@/lib/fulltrace/session-header";

// Limits
const MAX_PAYLOAD_BYTES = 500_000;          // hard cap; SDK should target <200KB gzipped
const MAX_DESCRIPTION_LENGTH = 1_000;
const PER_PROJECT_PER_MINUTE = 10;
const PER_PROJECT_PER_DAY = 50;             // V0 free-tier cap; revisit per-plan in V0.5

export async function POST(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> },
): Promise<NextResponse> {
  const { projectId } = await params;

  // ── Validate path ──────────────────────────────────────────────────────────
  if (!isUuid(projectId)) {
    return NextResponse.json({ error: "Invalid project ID" }, { status: 400 });
  }

  // ── Auth: Bearer iwk_pub_v1_… project token ────────────────────────────────
  const authHeader = req.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  if (!isProjectTokenSecret(bearer)) {
    return NextResponse.json(
      { error: "Missing or invalid bearer token" },
      { status: 401 },
    );
  }

  // ── IP rate limiting (anti-DOS, BEFORE the DB lookup) ──────────────────────
  const ip = extractClientIp(req);
  const ipRl = await checkWebhookRateLimit(ip);
  if (!ipRl.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(ipRl.retryAfter) } },
    );
  }

  // ── Pre-check Content-Length before reading body into memory ───────────────
  const contentLength = parseInt(req.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_PAYLOAD_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  // ── Resolve auth subject ───────────────────────────────────────────────────
  const subject = await loadIntegrationByToken(bearer);
  if (!subject) {
    return NextResponse.json({ error: "Invalid project token" }, { status: 401 });
  }
  if (subject.projectId !== projectId) {
    // Defense-in-depth: a token minted for project A must not be usable
    // against project B by altering the URL.
    return NextResponse.json(
      { error: "Token does not match URL project" },
      { status: 401 },
    );
  }

  // ── Per-project rate limits ────────────────────────────────────────────────
  const minuteRl = await rateLimit(
    "visual-reports-minute",
    subject.projectId,
    { windowMs: 60_000, max: PER_PROJECT_PER_MINUTE },
  );
  if (!minuteRl.allowed) {
    return NextResponse.json(
      { error: "Too many visual reports — slow down" },
      {
        status: 429,
        headers: { "Retry-After": String(minuteRl.retryAfterSeconds ?? 60) },
      },
    );
  }

  const dayRl = await rateLimit(
    "visual-reports-daily",
    subject.projectId,
    { windowMs: 86_400_000, max: PER_PROJECT_PER_DAY },
  );
  if (!dayRl.allowed) {
    return NextResponse.json(
      { error: "Daily visual report cap reached for this project" },
      {
        status: 429,
        headers: { "Retry-After": String(dayRl.retryAfterSeconds ?? 3600) },
      },
    );
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  const rawBody = await req.text();
  if (rawBody.length > MAX_PAYLOAD_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const validation = validatePayload(payload);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  const body = validation.value;

  // ── FullTrace correlation ──────────────────────────────────────────────────
  const sessionId = extractSessionId(req, body.bundle as Record<string, unknown>);

  // ── Insert alert + visual_report row ───────────────────────────────────────
  const result = await createVisualReport({
    projectId:      subject.projectId,
    userId:         null,                     // anonymous widget submit; V1 can attach signed-in users
    screenshotUrl:  body.screenshot,
    bundle:         body.bundle,
    captureMs:      body.captureMs,
    payloadSize:    body.payloadSize ?? rawBody.length,
    redactionStats: body.redactionStats ?? null,
    description:    body.description,
    sessionId,
  });

  if (!result) {
    // createVisualReport returns null only when an active maintenance
    // window suppressed the alert AND no prior bundle hash matched. Mirror
    // the capture-webhook semantics — accept the request silently so the
    // SDK doesn't surface a scary error to the user mid-maintenance.
    return NextResponse.json({
      ok: true,
      reportId:   null,
      alertId:    null,
      bundleHash: null,
      deduped:    false,
      suppressed: true,
    });
  }

  // ── Fire-and-forget AI diagnosis pipeline ──────────────────────────────────
  // The diagnosis takes ~15-30s on Qwen3.5-397B; we return immediately so the
  // SDK can show "Report submitted" UX. The pipeline persists every state
  // transition to visual_reports so the desktop client can stream progress.
  if (!result.deduped) {
    void import("@/lib/ai/visual-diagnosis").then(({ runVisualDiagnosis }) =>
      runVisualDiagnosis(result.reportId).catch((err) => {
        console.error("[visual-report] pipeline failed:", err);
      }),
    );
  }

  return NextResponse.json({
    ok:         true,
    reportId:   result.reportId,
    alertId:    result.alertId,
    bundleHash: result.bundleHash,
    deduped:    result.deduped,
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

type ValidPayload = {
  screenshot:      string;
  bundle:          Record<string, unknown>;
  description?:    string;
  captureMs?:      number;
  payloadSize?:    number;
  redactionStats?: Record<string, number> | null;
};

function validatePayload(p: unknown):
  | { ok: true;  value: ValidPayload }
  | { ok: false; error: string } {
  if (!p || typeof p !== "object") {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const obj = p as Record<string, unknown>;

  if (typeof obj.screenshot !== "string" || obj.screenshot.length < 32) {
    return { ok: false, error: "Missing or invalid screenshot" };
  }
  if (!obj.screenshot.startsWith("data:image/") && !obj.screenshot.startsWith("https://")) {
    return { ok: false, error: "Screenshot must be a data: URI or https:// URL" };
  }

  if (!obj.bundle || typeof obj.bundle !== "object" || Array.isArray(obj.bundle)) {
    return { ok: false, error: "Missing or invalid bundle" };
  }

  const out: ValidPayload = {
    screenshot: obj.screenshot,
    bundle:     obj.bundle as Record<string, unknown>,
  };

  if (obj.description !== undefined) {
    if (typeof obj.description !== "string") {
      return { ok: false, error: "description must be a string" };
    }
    out.description = obj.description.slice(0, MAX_DESCRIPTION_LENGTH);
  }

  if (obj.captureMs !== undefined) {
    if (typeof obj.captureMs !== "number" || obj.captureMs < 0 || obj.captureMs > 60_000) {
      return { ok: false, error: "captureMs must be a number 0..60000" };
    }
    out.captureMs = Math.round(obj.captureMs);
  }

  if (obj.payloadSize !== undefined) {
    if (typeof obj.payloadSize !== "number" || obj.payloadSize < 0) {
      return { ok: false, error: "payloadSize must be a non-negative number" };
    }
    out.payloadSize = Math.round(obj.payloadSize);
  }

  if (obj.redactionStats !== undefined && obj.redactionStats !== null) {
    if (typeof obj.redactionStats !== "object" || Array.isArray(obj.redactionStats)) {
      return { ok: false, error: "redactionStats must be a plain object" };
    }
    const stats: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj.redactionStats)) {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
        stats[k] = Math.round(v);
      }
    }
    out.redactionStats = stats;
  }

  return { ok: true, value: out };
}
