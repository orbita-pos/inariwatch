import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";
import { rateLimit } from "@/lib/auth-rate-limit";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const handler = NextAuth(authOptions);

// B3 (VERCEL_LEVEL_AUDIT_REPORT.md): IP-level rate limit on the endpoints
// most abused by credential stuffing + OAuth-callback flooding.
//
// The existing per-email limit in lib/auth.ts:authorize() blocks serial
// retries against one account, but an attacker rotating 1000 emails from
// one IP slips through. This pre-handler limit caps IPs at 20 req/min
// across every NextAuth endpoint that matters (signin form post, OAuth
// init, OAuth callback), with the Redis-backed sliding window and the
// DB fallback baked into rateLimit().
//
// Intentionally permissive on the "csrf" + "session" + "providers"
// subpaths — those fire on every dashboard render (session poll) and
// blocking them breaks the app.
const RATE_LIMITED_NEXTAUTH_PATHS = new Set([
  "callback/credentials",
  "signin/credentials",
  "signin/github",
  "signin/google",
  "signin/gitlab",
  "callback/github",
  "callback/google",
  "callback/gitlab",
]);

function extractClientIp(req: NextRequest): string {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-real-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

async function withIpRateLimit(req: NextRequest, ctx: { params: Promise<{ nextauth: string[] }> }) {
  const params = await ctx.params;
  const path = params.nextauth?.join("/") ?? "";

  if (RATE_LIMITED_NEXTAUTH_PATHS.has(path)) {
    const ip = extractClientIp(req);
    const rl = await rateLimit("auth-ip", ip, { windowMs: 60_000, max: 20 });
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many requests" },
        {
          status: 429,
          headers: {
            "Retry-After": String(rl.retryAfterSeconds ?? 60),
            "Cache-Control": "private, no-store",
          },
        },
      );
    }
  }

  // Delegate to NextAuth's handler for everything else.
  return handler(req, ctx);
}

export { withIpRateLimit as GET, withIpRateLimit as POST };
