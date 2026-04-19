import { headers } from "next/headers";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Diagnostic: echo every header the app sees, plus the IP that
 * extractClientIp() would resolve to. Used to pin down why the
 * register rate limit keyed by client IP collapses to "unknown" on
 * kamal-proxy.
 *
 * Safe to expose because:
 *   1. Only returns headers of the CURRENT request — no cross-user leak.
 *   2. All the data is already visible to the client as the request
 *      headers it sent, modulo what kamal-proxy annotates on top, which
 *      is what we're trying to learn.
 *
 * Remove once the proxy header issue is resolved (tracked alongside
 * the DNS cutover).
 */
export async function GET(): Promise<NextResponse> {
  const h = await headers();
  const entries = Array.from(h.entries())
    .filter(([k]) => k.toLowerCase() !== "cookie")
    .sort(([a], [b]) => a.localeCompare(b));

  const xff = h.get("x-forwarded-for");
  const xffParts = xff ? xff.split(",").map((s) => s.trim()).filter(Boolean) : [];

  return NextResponse.json({
    extractedBy: {
      xRealIp: h.get("x-real-ip") ?? null,
      xffRightmost: xffParts.length ? xffParts[xffParts.length - 1] : null,
      xffLeftmost: xffParts.length ? xffParts[0] : null,
      xffAll: xffParts,
    },
    allHeaders: Object.fromEntries(entries),
  });
}
