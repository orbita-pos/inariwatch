import { NextRequest, NextResponse } from "next/server";

import { blastRadius } from "@/lib/code-intelligence-v2/queries";

import { authorize, badRequest, resolveRepoId } from "../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/code-intel-v2/blast-radius
 *
 * Body: { projectId?: string, repoId?: string, symbolFqn: string, depth?: number }
 *
 * Returns the transitive caller closure at `depth` (default 2, capped at 5
 * inside queries.blastRadius). Used by the worker tool of the same name to
 * surface "what could break if I change X" before applying a fix.
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
  const depth =
    typeof body.depth === "number" && Number.isFinite(body.depth)
      ? Math.floor(body.depth)
      : undefined;

  const repoId = await resolveRepoId({
    projectId: typeof body.projectId === "string" ? body.projectId : undefined,
    repoId: typeof body.repoId === "string" ? body.repoId : undefined,
  });
  if (!repoId) {
    return NextResponse.json({ error: "no v2-ready repo for this project" }, { status: 404 });
  }

  const result = await blastRadius(symbolFqn, repoId, depth);
  return NextResponse.json({
    repoId,
    symbolFqn,
    depth: result.depth,
    symbols: result.symbols,
    count: result.symbols.length,
  });
}
