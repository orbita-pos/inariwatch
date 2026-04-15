import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { replaySessions, projects } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { uploadBlock, sessionPrefix } from "@/lib/storage/replay-storage";
import { isReplayV2Enabled } from "@/lib/feature-flags";
import { checkWebhookRateLimit, extractClientIp } from "@/lib/webhooks/rate-limit";
import { rateLimit } from "@/lib/auth-rate-limit";
import { isOriginAllowed } from "@/lib/replay-origin";
import {
  validateIngestBody,
  extractClickSelectors,
  extractUrls,
  extractErrorFingerprints,
  SELECTOR_LIMIT,
  URL_LIMIT,
  ERROR_FP_LIMIT,
  type IngestBody,
} from "./helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024; // 2 MB raw JSON, ~256 KB gzipped

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
  // Rate limit by IP first (cheapest check)
  const ip = extractClientIp(req);
  const rl = await checkWebhookRateLimit(ip);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: rl.retryAfter ? { "retry-after": String(rl.retryAfter) } : undefined },
    );
  }

  // Hard payload cap
  const contentLength = parseInt(req.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_PAYLOAD_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  let body: IngestBody;
  try {
    body = (await req.json()) as IngestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Schema validation
  const validation = validateIngestBody(body);
  if (validation) return NextResponse.json({ error: validation }, { status: 400 });

  // Resolve project + organization
  const [proj] = await db
    .select({
      id: projects.id,
      organizationId: projects.organizationId,
      userId: projects.userId,
      allowedOrigins: projects.allowedOrigins,
    })
    .from(projects)
    .where(eq(projects.id, body.projectId))
    .limit(1);

  if (!proj) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Feature flag gate (org-level)
  if (!isReplayV2Enabled(proj.organizationId)) {
    return NextResponse.json({ error: "Replay V2 not enabled for this organization" }, { status: 403 });
  }

  // Origin allowlist — only enforced when the project has configured entries.
  // An empty list preserves pre-0048 behaviour (accept any Origin) so no
  // existing integration breaks when this column ships.
  const originDecision = isOriginAllowed(req.headers.get("origin"), proj.allowedOrigins);
  if (!originDecision.allowed) {
    return NextResponse.json(
      { error: `Origin not allowed (${originDecision.reason})` },
      { status: 403 },
    );
  }

  if (!proj.organizationId) {
    return NextResponse.json({ error: "Project has no organization" }, { status: 400 });
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
        headers: projectRl.retryAfterSeconds
          ? { "retry-after": String(projectRl.retryAfterSeconds) }
          : undefined,
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
      return NextResponse.json({ error: msg }, { status: 413 });
    }
    if (msg.includes("R2 not configured") || msg.includes("R2_BUCKET")) {
      return NextResponse.json({ error: "Replay storage not configured" }, { status: 503 });
    }
    console.error("[replay/ingest] R2 upload failed:", msg);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }

  // Extract searchable index from events (best-effort, never throws)
  const clickSelectors = extractClickSelectors(body.events).slice(0, SELECTOR_LIMIT);
  const urlsVisited = extractUrls(body.events).slice(0, URL_LIMIT);
  const errorFingerprints = extractErrorFingerprints(body.events).slice(0, ERROR_FP_LIMIT);

  // Upsert session metadata (first block creates row, subsequent blocks update counters)
  const startedAtDate = new Date(body.metadata?.startedAt ?? Date.now());
  const isFinal = body.metadata?.isFinal === true;
  const endedAtDate = isFinal && body.metadata?.endedAt ? new Date(body.metadata.endedAt) : null;

  const sessionAlreadyEnded = isFinal;

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
    })
    .onConflictDoUpdate({
      target: replaySessions.sessionId,
      set: {
        // block_count = max(block_count, blockIndex + 1) — handles out-of-order arrival
        blockCount: sql`GREATEST(${replaySessions.blockCount}, ${body.blockIndex + 1})`,
        totalBytes: sql`${replaySessions.totalBytes} + ${upload.bytes}`,
        endedAt: endedAtDate ?? replaySessions.endedAt,
        durationMs: isFinal ? body.endMs : sql`COALESCE(${replaySessions.durationMs}, NULL)`,
        clickSelectors: sql`(SELECT ARRAY(SELECT DISTINCT unnest(${replaySessions.clickSelectors} || ${clickSelectors}::text[])))`,
        urlsVisited: sql`(SELECT ARRAY(SELECT DISTINCT unnest(${replaySessions.urlsVisited} || ${urlsVisited}::text[])))`,
        errorFingerprints: sql`(SELECT ARRAY(SELECT DISTINCT unnest(${replaySessions.errorFingerprints} || ${errorFingerprints}::text[])))`,
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

  return NextResponse.json({
    ok: true,
    sessionId: body.sessionId,
    blockIndex: body.blockIndex,
    bytes: upload.bytes,
  });
}
