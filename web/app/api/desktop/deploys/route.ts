import { NextRequest, NextResponse } from "next/server";
import { authenticateExtensionToken, unauthorized } from "@/lib/auth-extension";
import { getDeploysSummary } from "@/lib/services/desktop-widgets.service";

export async function GET(req: NextRequest) {
  const auth = await authenticateExtensionToken(req);
  if (!auth) return unauthorized();

  const parsed = parseInt(req.nextUrl.searchParams.get("limit") ?? "", 10);
  // Treat NaN (missing / non-numeric) as the default 8; clamp the rest
  // into [1, 32]. `|| 8` would conflate the legitimate `0` value with
  // NaN, so we use `Number.isFinite` explicitly.
  const limit = Math.min(Math.max(Number.isFinite(parsed) ? parsed : 8, 1), 32);
  const summary = await getDeploysSummary(auth.projectIds, limit);
  return NextResponse.json(summary);
}
