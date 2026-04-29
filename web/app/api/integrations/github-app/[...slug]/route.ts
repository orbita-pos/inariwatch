// Catch-all for /api/integrations/github-app/* paths that don't match a
// real route. Exists specifically to handle the GitHub App's Setup URL
// occasionally getting a trailing whitespace ("/setup ") — Next 404s
// before middleware runs on whitespace paths, so we need an actual route
// file to intercept and 308 to the cleaned canonical URL.
//
// Clean paths (e.g. /setup) are handled by their dedicated route.ts and
// never reach here.

import { NextResponse } from "next/server";

const APP_BASE = (
  process.env.NEXTAUTH_URL
    ?? process.env.APP_URL
    ?? process.env.NEXT_PUBLIC_APP_URL
    ?? "https://app.inariwatch.com"
).replace(/\/$/, "");

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  const { slug } = await params;
  const cleaned = slug.map((s) => s.replace(/\s+/g, "")).filter(Boolean).join("/");
  if (!cleaned) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const url = new URL(req.url);
  const target = `${APP_BASE}/api/integrations/github-app/${cleaned}${url.search}`;
  return NextResponse.redirect(target, { status: 308 });
}

export const POST = GET;
