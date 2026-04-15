import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { isReplayV2Enabled } from "@/lib/feature-flags";
import { DEFAULT_REPLAY_SETTINGS, type ReplaySettings } from "@/lib/db/schema";
import { buildCorsHeaders, corsPreflightResponse } from "@/lib/replay-cors";
import { checkWebhookRateLimit, extractClientIp } from "@/lib/webhooks/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/replay/config/[projectId]
 *
 * Public read-only endpoint the SDK calls on init. Returns the merged
 * replay settings (stored patch + hardcoded defaults) so the browser can
 * honour sampling + buffer rules set in the dashboard.
 *
 * Auth: projectId is public (same model as /api/replay/ingest — it's already
 * exposed in the customer's HTML). Per-IP rate limit prevents enumeration
 * abuse. No secret is returned.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
): Promise<NextResponse> {
  const origin = req.headers.get("origin");
  const cors = buildCorsHeaders(origin, null);

  const ip = extractClientIp(req);
  const rl = await checkWebhookRateLimit(ip);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: cors },
    );
  }

  const { projectId } = await params;
  if (!UUID_RE.test(projectId)) {
    return NextResponse.json({ error: "Invalid projectId" }, { status: 400, headers: cors });
  }

  const [proj] = await db
    .select({
      organizationId: projects.organizationId,
      replaySettings: projects.replaySettings,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!proj) {
    return NextResponse.json({ error: "Project not found" }, { status: 404, headers: cors });
  }

  if (!isReplayV2Enabled(proj.organizationId)) {
    // Same shape as "disabled": the SDK will keep recording client-side but
    // never try to flush. Avoids leaking whether this project exists or not.
    return NextResponse.json(
      { settings: { ...DEFAULT_REPLAY_SETTINGS, enabled: false } },
      { headers: { ...cors, "cache-control": "public, max-age=60" } },
    );
  }

  const merged: Required<ReplaySettings> = {
    ...DEFAULT_REPLAY_SETTINGS,
    ...((proj.replaySettings ?? {}) as ReplaySettings),
  };

  return NextResponse.json(
    { settings: merged },
    {
      headers: {
        ...cors,
        // 60s browser cache — balances "take effect fast when the owner
        // flips a toggle" against "don't hammer the endpoint on every init".
        "cache-control": "public, max-age=60",
      },
    },
  );
}

export async function OPTIONS(req: NextRequest) {
  return corsPreflightResponse(req.headers.get("origin"), null);
}
