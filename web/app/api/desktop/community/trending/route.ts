import { NextRequest, NextResponse } from "next/server";
import { authenticateExtensionToken, unauthorized } from "@/lib/auth-extension";
import { getCommunityTrending } from "@/lib/services/desktop-widgets.service";

export async function GET(req: NextRequest) {
  const auth = await authenticateExtensionToken(req);
  if (!auth) return unauthorized();

  const parsed = parseInt(req.nextUrl.searchParams.get("limit") ?? "", 10);
  // NaN → default 8; finite numbers → clamped to [1, 32]. Avoids the
  // `0 || 8 === 8` conflation a falsy-OR fallback would introduce.
  const limit = Math.min(Math.max(Number.isFinite(parsed) ? parsed : 8, 1), 32);
  const trending = await getCommunityTrending(limit);
  return NextResponse.json(trending);
}
