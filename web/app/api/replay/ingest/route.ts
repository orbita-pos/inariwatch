import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { replaySessions, projects } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { uploadBlock, sessionPrefix } from "@/lib/storage/replay-storage";
import { isReplayV2Enabled } from "@/lib/feature-flags";
import { DEFAULT_REPLAY_SETTINGS, type ReplaySettings } from "@/lib/db/schema";
import { checkWebhookRateLimit, extractClientIp } from "@/lib/webhooks/rate-limit";
import { rateLimit } from "@/lib/auth-rate-limit";
import { isOriginAllowed } from "@/lib/replay-origin";
import { buildCorsHeaders, corsPreflightResponse } from "@/lib/replay-cors";
import {
  validateIngestBody,
  extractClickSelectors,
  extractUrls,
  extractErrorFingerprints,
  extractWebVitals,
  sanitizeEndUserField,
  SELECTOR_LIMIT,
  URL_LIMIT,
  ERROR_FP_LIMIT,
  type IngestBody,
  type WebVitalsSnapshot,
} from "./helpers";
import { sha256Lower } from "@/lib/hash";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024; // 2 MB raw JSON, ~256 KB gzipped

/**
 * CORS preflight. We don't yet know which project the caller is targeting,
 * so the preflight response reflects the origin unconditionally — the real
 * POST still enforces the per-project allowlist.
 */
export async function OPTIONS(req: NextRequest) {
  return corsPreflightResponse(req.headers.get("origin"), null);
}

/**
 * POST /api/replay/ingest
 *
 * Receives a single replay block from the browser SDK. The endpoint is
 * gated by the REPLAY_V2 feature flag at the organization level — orgs
 * without the flag get 403 even if their projectId is valid.
 *
 * Auth model: the project UUID acts as a public key (it's already exposed
 * to anyone with dashboard access). Per-IP rate limiting + per-block size
 * limits protect against abuse. Org-level storage caps ship in Phase 1.
 */
export async function POST(req: NextRequest) {
  // CORS headers on every response — without this the browser masks error
  // bodies from the SDK, making debugging impossible. We use the pre-auth
  // variant (null allowlist) for responses emitted before we know the project.
  const origin = req.headers.get("origin");
  const preAuthCors = buildCorsHeaders(origin, null);

  // Rate limit by IP first (cheapest check)
  const ip = extractClientIp(req);
  const rl = await checkWebhookRateLimit(ip);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: {
          ...preAuthCors,
          ...(rl.retryAfter ? { "retry-after": String(rl.retryAfter) } : {}),
        },
      },
    );
  }

  // Hard payload cap
  const contentLength = parseInt(req.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_PAYLOAD_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413, headers: preAuthCors });
  }

  let body: IngestBody;
  try {
    body = (await req.json()) as IngestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: preAuthCors });
  }

  // Schema validation
  const validation = validateIngestBody(body);
  if (validation) return NextResponse.json({ error: validation }, { status: 400, headers: preAuthCors });

  // Resolve project + organization + replay settings
  const [proj] = await db
    .select({
      id: projects.id,
      organizationId: projects.organizationId,
      userId: projects.userId,
      allowedOrigins: projects.allowedOrigins,
      replaySettings: projects.replaySettings,
    })
    .from(projects)
    .where(eq(projects.id, body.projectId))
    .limit(1);

  if (!proj) {
    return NextResponse.json({ error: "Project not found" }, { status: 404, headers: preAuthCors });
  }

  // Post-project-lookup CORS uses the project's actual allowlist
  const projCors = buildCorsHeaders(origin, proj.allowedOrigins);

  // Feature flag gate (org-level)
  if (!isReplayV2Enabled(proj.organizationId)) {
    return NextResponse.json(
      { error: "Replay V2 not enabled for this organization" },
      { status: 403, headers: projCors },
    );
  }

  // Per-project kill switch. Merged with DEFAULT_REPLAY_SETTINGS so an empty
  // jsonb means "defaults apply". When enabled is explicitly false, the
  // project owner has disabled recording and we reject every block — the
  // SDK should have stopped upstream via /api/replay/config, this is the
  // server-side enforcement backstop.
  const settings: Required<ReplaySettings> = {
    ...DEFAULT_REPLAY_SETTINGS,
    ...((proj.replaySettings ?? {}) as ReplaySettings),
  };
  if (settings.enabled === false) {
    return NextResponse.json(
      { error: "Replay recording disabled for this project" },
      { status: 403, headers: projCors },
    );
  }

  // Origin allowlist — only enforced when the project has configured entries.
  // An empty list preserves pre-0048 behaviour (accept any Origin) so no
  // existing integration breaks when this column ships.
  const originDecision = isOriginAllowed(origin, proj.allowedOrigins);
  if (!originDecision.allowed) {
    return NextResponse.json(
      { error: `Origin not allowed (${originDecision.reason})` },
      { status: 403, headers: projCors },
    );
  }

  if (!proj.organizationId) {
    return NextResponse.json(
      { error: "Project has no organization" },
      { status: 400, headers: projCors },
    );
  }

  // Per-project rate limit: 500 blocks/hour. IP-level rate limit above is
  // trivially bypassable with a botnet; this caps total storage abuse on a
  // single project even when the attacker rotates IPs.
  const projectRl = await rateLimit("replay:ingest:project", proj.id, {
    windowMs: 60 * 60 * 1000,
    max: 500,
  });
  if (!projectRl.allowed) {
    return NextResponse.json(
      { error: "Project ingest quota exceeded" },
      {
        status: 429,
        headers: {
          ...projCors,
          ...(projectRl.retryAfterSeconds ? { "retry-after": String(projectRl.retryAfterSeconds) } : {}),
        },
      },
    );
  }

  // Upload block to R2 — storage layer enforces its own size/count limits
  let upload: { key: string; bytes: number };
  try {
    upload = await uploadBlock({
      organizationId: proj.organizationId,
      sessionId: body.sessionId,
      blockIndex: body.blockIndex,
      startMs: body.startMs,
      endMs: body.endMs,
      events: body.events,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Upload failed";
    if (msg.includes("exceeds max")) {
      return NextResponse.json({ error: msg }, { status: 413, headers: projCors });
    }
    if (msg.includes("R2 not configured") || msg.includes("R2_BUCKET")) {
      return NextResponse.json({ error: "Replay storage not configured" }, { status: 503, headers: projCors });
    }
    console.error("[replay/ingest] R2 upload failed:", msg);
    return NextResponse.json({ error: "Upload failed" }, { status: 500, headers: projCors });
  }

  // Extract searchable index from events (best-effort, never throws)
  const clickSelectors = extractClickSelectors(body.events).slice(0, SELECTOR_LIMIT);
  const urlsVisited = extractUrls(body.events).slice(0, URL_LIMIT);
  const errorFingerprints = extractErrorFingerprints(body.events).slice(0, ERROR_FP_LIMIT);

  // Phase F — end-user identity. Both fields are optional; sanitize and hash
  // even when only one is present. The DB column update below uses
  // first-write-wins so two parallel blocks for the same session can't
  // toggle the user id (the customer's app set it once at session start).
  const endUserId = sanitizeEndUserField(body.metadata?.user?.id);
  const endUserEmail = sanitizeEndUserField(body.metadata?.user?.email);
  const endUserEmailHash = sha256Lower(endUserEmail);

  // Phase G — extract Core Web Vitals from this block. Most blocks won't
  // contain any (the SDK only emits on visibility-hide and pagehide), so
  // this is usually an empty object except on the FINAL block.
  const blockVitals: WebVitalsSnapshot = extractWebVitals(body.events);
  const hasVitals = Object.keys(blockVitals).length > 0;

  // Upsert session metadata (first block creates row, subsequent blocks update counters)
  const startedAtDate = new Date(body.metadata?.startedAt ?? Date.now());
  const isFinal = body.metadata?.isFinal === true;
  const endedAtDate = isFinal && body.metadata?.endedAt ? new Date(body.metadata.endedAt) : null;

  const sessionAlreadyEnded = isFinal;

  // Merge a new text[] batch into an existing column, deduping.
  // Caveats we had to design around:
  //   1. Drizzle's `sql` template literal binds JS arrays as comma-joined
  //      strings, not as Postgres text[]. `${arr}::text[]` produces a
  //      "malformed array literal" error. We format the array as a Postgres
  //      literal string `{"a","b"}` and cast it explicitly.
  //   2. If the new batch is empty, `unnest(col || '{}'::text[])` still
  //      chokes. Skip the merge entirely — the existing column is preserved.
  const toPgArrayLiteral = (arr: string[]): string =>
    "{" + arr.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",") + "}";

  const mergeTextArray = <T>(col: T, arr: string[]): T | ReturnType<typeof sql> => {
    if (arr.length === 0) return col;
    const literal = toPgArrayLiteral(arr);
    return sql`(SELECT ARRAY(SELECT DISTINCT unnest(${col} || ${literal}::text[])))`;
  };

  await db
    .insert(replaySessions)
    .values({
      sessionId: body.sessionId,
      organizationId: proj.organizationId,
      projectId: proj.id,
      userId: proj.userId,
      startedAt: startedAtDate,
      endedAt: endedAtDate,
      durationMs: isFinal ? body.endMs : null,
      r2Prefix: sessionPrefix(proj.organizationId, body.sessionId),
      blockCount: 1,
      totalBytes: upload.bytes,
      clickSelectors: clickSelectors,
      urlsVisited: urlsVisited,
      errorFingerprints: errorFingerprints,
      browser: body.metadata?.browser ?? null,
      os: body.metadata?.os ?? null,
      viewport: body.metadata?.viewport ?? null,
      endUserId: endUserId,
      endUserEmail: endUserEmail,
      endUserEmailHash: endUserEmailHash,
      // Phase G: persist whatever vitals this block carried (usually only
      // the final block ships any). Subsequent blocks merge via `||` below.
      webVitals: blockVitals,
    })
    .onConflictDoUpdate({
      target: replaySessions.sessionId,
      set: {
        // block_count = max(block_count, blockIndex + 1) — handles out-of-order arrival
        blockCount: sql`GREATEST(${replaySessions.blockCount}, ${body.blockIndex + 1})`,
        totalBytes: sql`${replaySessions.totalBytes} + ${upload.bytes}`,
        endedAt: endedAtDate ?? replaySessions.endedAt,
        // Persist the highest endMs we've seen across every block — makes
        // durationMs accurate even when the user never triggered the final
        // `isFinal: true` flush (tab crashed, laptop slept, etc.).
        durationMs: sql`GREATEST(COALESCE(${replaySessions.durationMs}, 0), ${body.endMs})`,
        clickSelectors: mergeTextArray(replaySessions.clickSelectors, clickSelectors),
        urlsVisited: mergeTextArray(replaySessions.urlsVisited, urlsVisited),
        errorFingerprints: mergeTextArray(replaySessions.errorFingerprints, errorFingerprints),
        // First-write-wins for end-user fields. COALESCE keeps whatever was
        // stored from the FIRST block that carried a user, even if later
        // blocks ship a different (or null) value. This protects against:
        //   1. SDKs that set the user mid-session — first block has nothing,
        //      later blocks have the email; the COALESCE preserves it.
        //   2. Races where a block arrives after the customer's app cleared
        //      __INARIWATCH_USER__ on logout.
        endUserId: sql`COALESCE(${replaySessions.endUserId}, ${endUserId})`,
        endUserEmail: sql`COALESCE(${replaySessions.endUserEmail}, ${endUserEmail})`,
        endUserEmailHash: sql`COALESCE(${replaySessions.endUserEmailHash}, ${endUserEmailHash})`,
        // Postgres `||` jsonb operator does a SHALLOW MERGE keyed by top-level
        // key. New block's vital wins when both sides set the same metric —
        // semantically correct because vitals settle late in the session,
        // so the LATEST measurement is the canonical one.
        webVitals: hasVitals
          ? sql`${replaySessions.webVitals} || ${JSON.stringify(blockVitals)}::jsonb`
          : replaySessions.webVitals,
        updatedAt: new Date(),
      },
    });

  // On the final block, enqueue the AI analyze job. Fire-and-forget — the
  // enqueue helper never throws, and downstream processing is idempotent.
  if (sessionAlreadyEnded) {
    const { enqueue } = await import("@/lib/queue");
    // Small delay so any late-arriving blocks land before analysis starts.
    void enqueue(
      "replay-analyze",
      { sessionId: body.sessionId },
      { queue: "default", delay: 5000 },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      sessionId: body.sessionId,
      blockIndex: body.blockIndex,
      bytes: upload.bytes,
    },
    { headers: projCors },
  );
}
