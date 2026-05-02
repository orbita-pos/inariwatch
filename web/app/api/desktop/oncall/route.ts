import { NextRequest, NextResponse } from "next/server";
import { authenticateExtensionToken, unauthorized } from "@/lib/auth-extension";
import { getOncallStatus } from "@/lib/services/desktop-widgets.service";

export async function GET(req: NextRequest) {
  const auth = await authenticateExtensionToken(req);
  if (!auth) return unauthorized();

  const status = await getOncallStatus(auth.projectIds);
  return NextResponse.json(status);
}
