import { NextRequest, NextResponse } from "next/server";
import { authenticateExtensionToken, unauthorized } from "@/lib/auth-extension";
import { getUptimeSummary } from "@/lib/services/desktop-widgets.service";

/**
 * GET /api/desktop/uptime — Inari Live cloud-dashboard widget.
 *
 * Auth: same Bearer-token surface as /api/desktop/alerts. Token must be
 * stored under service="desktop". Inari Live obtains it via the device
 * flow (`/api/cli/auth/poll?client=desktop`).
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateExtensionToken(req);
  if (!auth) return unauthorized();

  const summary = await getUptimeSummary(auth.projectIds);
  return NextResponse.json(summary);
}
