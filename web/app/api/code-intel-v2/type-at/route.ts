import { NextRequest, NextResponse } from "next/server";

import { typeAt } from "@/lib/code-intelligence-v2/queries";

import { authorize, badRequest, resolveRepoId } from "../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/code-intel-v2/type-at
 *
 * Body: { projectId?: string, repoId?: string, filePath: string, line: number, col?: number }
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

  const filePath = typeof body.filePath === "string" ? body.filePath : null;
  const line = typeof body.line === "number" && Number.isFinite(body.line) ? Math.floor(body.line) : null;
  if (!filePath) return badRequest("filePath is required");
  if (line === null || line < 1) return badRequest("line must be a positive integer");
  const col =
    typeof body.col === "number" && Number.isFinite(body.col) ? Math.floor(body.col) : null;

  const repoId = await resolveRepoId({
    projectId: typeof body.projectId === "string" ? body.projectId : undefined,
    repoId: typeof body.repoId === "string" ? body.repoId : undefined,
  });
  if (!repoId) {
    return NextResponse.json({ error: "no v2-ready repo for this project" }, { status: 404 });
  }

  const result = await typeAt(filePath, line, col, repoId);
  if (!result) return NextResponse.json({ repoId, filePath, line, col, type: null, symbol: null });

  return NextResponse.json({
    repoId,
    filePath,
    line,
    col,
    type: result.type,
    symbol: result.symbol,
  });
}
