/**
 * POST /api/projects/{projectId}/tokens/{tokenId}/rotate
 *
 * Mint a fresh token + link the old one via `rotated_to`. Both work for
 * 24h; cron `rotate-grace` then revokes the old one. Plaintext for the
 * new token is in this response only — see Recovery decision in
 * INARI_LIVE_V1_PLAN.md.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizeProjectForTokens } from "../../_authorize";
import {
  rotateToken,
  ProjectTokenError,
} from "@/lib/services/project-tokens.service";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";

const VALID_CREATED_VIA = new Set(["web", "desktop", "cli", "api"] as const);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; tokenId: string }> },
) {
  const { projectId, tokenId } = await params;
  const auth = await authorizeProjectForTokens(projectId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  if (!isUuid(tokenId)) {
    return NextResponse.json({ error: "Invalid token id" }, { status: 400 });
  }

  let body: { device_label?: unknown; created_via?: unknown } = {};
  if (req.headers.get("content-length") && Number(req.headers.get("content-length")) > 0) {
    try {
      body = (await req.json()) ?? {};
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  const createdViaRaw = typeof body.created_via === "string" ? body.created_via : "web";
  if (!VALID_CREATED_VIA.has(createdViaRaw as typeof VALID_CREATED_VIA extends Set<infer T> ? T : never)) {
    return NextResponse.json({ error: "Invalid created_via" }, { status: 400 });
  }
  const createdVia = createdViaRaw as "web" | "desktop" | "cli" | "api";

  const deviceLabel =
    typeof body.device_label === "string" && body.device_label.length > 0
      ? body.device_label.slice(0, 100)
      : null;

  let result;
  try {
    result = await rotateToken({
      projectId:   auth.projectId,
      oldTokenId:  tokenId,
      workspaceId: auth.workspaceId,
      createdVia,
      createdBy:   auth.userId,
      deviceLabel,
    });
  } catch (err) {
    if (err instanceof ProjectTokenError) {
      const status = err.code === "token_not_found" ? 404 : 409;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    throw err;
  }

  await logAudit({
    userId:     auth.userId,
    action:     "project_token.rotate",
    resource:   "project_token",
    resourceId: result.id,
    metadata: {
      projectId:    auth.projectId,
      supersedes:   result.supersedes,
      fingerprint:  result.fingerprint,
      graceEndsAt:  result.graceEndsAt,
      createdVia,
    },
  });

  return NextResponse.json(
    {
      id:            result.id,
      token:         result.token,           // PLAINTEXT — shown ONCE
      fingerprint:   result.fingerprint,
      dsn:           result.dsn,
      created_at:    result.createdAt.toISOString(),
      scope:         result.scope,
      supersedes:    result.supersedes,
      grace_ends_at: result.graceEndsAt,
    },
    { status: 201 },
  );
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
