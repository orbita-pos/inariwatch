import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/health
 *
 * Liveness probe for Kamal / Caddy / uptime monitors. Intentionally does
 * no DB or external-service work — a pure liveness signal. If the Node
 * process is serving requests at all, it's "healthy" enough for a
 * reverse proxy to route traffic.
 *
 * Readiness (DB reachable, Redis reachable, R2 signable) lives on
 * /api/health/ready if we ever need it — most orchestrators treat the
 * two as separate concerns. For now, Kamal only needs liveness.
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    ok: true,
    ts: new Date().toISOString(),
    // The container image tag is set at build time via an ENV in the
    // Dockerfile; falls back to "dev" if we're running `next dev`.
    version: process.env.APP_VERSION ?? "dev",
  });
}
