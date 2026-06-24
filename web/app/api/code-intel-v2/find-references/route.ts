import { NextRequest, NextResponse } from "next/server";

import { findReferences } from "@/lib/code-intelligence-v2/queries";

import { authorize, badRequest, resolveRepoId } from "../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/code-intel-v2/find-references
 *
 * Body: { projectId?: string, repoId?: string, symbolFqn: string, kind?: string, limit?: number }
 * Auth: Bearer CRON_SECRET (matches existing worker → web pattern).
 *
 * Worker tool `find_references` calls this. Returns up to `limit` (default 50)
 * references — one row per use-site.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const unauth = authorize(req);
  if (unauth) return unauth;

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return badRequest("invalid JSON body");
  }

  const symbolFqn = typeof body.symbolFqn === "string" ? body.symbolFqn : null;
  if (!symbolFqn) return badRequest("symbolFqn is required");
  const kind = typeof body.kind === "string" ? body.kind : undefined;
  const limit =
    typeof body.limit === "number" && Number.isFinite(body.limit)
      ? Math.max(1, Math.min(Math.floor(body.limit), 200))
      : 50;

  const repoId = await resolveRepoId({
    projectId: typeof body.projectId === "string" ? body.projectId : undefined,
    repoId: typeof body.repoId === "string" ? body.repoId : undefined,
  });
  if (!repoId) {
    return NextResponse.json({ error: "no v2-ready repo for this project" }, { status: 404 });
  }

  const refs = await findReferences(symbolFqn, repoId, kind);
  return NextResponse.json({
    repoId,
    symbolFqn,
    kind: kind ?? null,
    references: refs.slice(0, limit),
    truncated: refs.length > limit,
    totalFound: refs.length,
  });
}
