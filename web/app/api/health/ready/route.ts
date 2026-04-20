import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/health/ready
 *
 * Readiness probe — does the app have working connections to the backing
 * services it needs to serve real traffic? Right now that's the primary
 * Postgres (Neon). Redis has a per-call DB fallback in every caller, so a
 * Redis blip should not mark the box unready.
 *
 * Separation of concerns:
 *   /api/health        — liveness  (Node process serves requests)
 *   /api/health/ready  — readiness (DB reachable, ready for traffic)
 *
 * Kamal-proxy + external uptime monitors can stay on liveness to avoid
 * flapping the box on transient DB hiccups; a future blue/green swap or
 * canary script can gate on readiness before flipping traffic.
 *
 * The `SELECT 1` is also useful as a keep-warm signal against Neon's
 * autosuspend when this route is pinged on a cron.
 */
export async function GET(): Promise<NextResponse> {
  try {
    await db.execute(sql`SELECT 1`);
  } catch (err) {
    return NextResponse.json(
      {
        ready: false,
        reason: "db_unreachable",
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 503 },
    );
  }

  return NextResponse.json({
    ready: true,
    ts: new Date().toISOString(),
    version: process.env.APP_VERSION ?? "dev",
  });
}
