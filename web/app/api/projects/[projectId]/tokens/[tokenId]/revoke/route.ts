/**
 * POST /api/projects/{projectId}/tokens/{tokenId}/revoke
 *
 * Hard revoke. The next capture call bearing this token 401s. No grace —
 * see "Project token model" decision in INARI_LIVE_V1_PLAN.md ("Revoke:
 * Immediate (no grace) when leak detected"). Used by the user manually
 * + by the GitHub Secret Scanning webhook handler (Session 7).
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizeProjectForTokens } from "../../_authorize";
import {
  revokeToken,
  ProjectTokenError,
} from "@/lib/services/project-tokens.service";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";

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

  let reason: string | null = null;
  if (req.headers.get("content-length") && Number(req.headers.get("content-length")) > 0) {
    try {
      const body = (await req.json()) as { reason?: unknown };
      if (typeof body?.reason === "string") {
        reason = body.reason.slice(0, 200);
      }
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  let result;
  try {
    result = await revokeToken({
      projectId: auth.projectId,
      tokenId,
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
    action:     "project_token.revoke",
    resource:   "project_token",
    resourceId: result.id,
    metadata: {
      projectId:  auth.projectId,
      revokedAt:  result.revokedAt.toISOString(),
      reason:     reason ?? undefined,
    },
  });

  return NextResponse.json({
    id:         result.id,
    revoked_at: result.revokedAt.toISOString(),
  });
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
