/**
 * Mobile auth — shared across all /api/mobile/* endpoints.
 * Single source of truth. DO NOT copy-paste into route files.
 */

import { db, apiKeys } from "@/lib/db";
import { eq, and, sql } from "drizzle-orm";
import { decrypt } from "@/lib/crypto";
import { rateLimit } from "@/lib/auth-rate-limit";
import { timingSafeEqual, createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";

/**
 * Authenticate a mobile request via Bearer token.
 * Uses token prefix hash for O(1) lookup instead of full table scan.
 */
export async function authenticateMobile(req: NextRequest): Promise<string | null> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;

  // Query by service only (mobile keys are rare, typically 1-5 per user)
  const keys = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.service, "mobile"))
    .limit(50);

  for (const key of keys) {
    const decrypted = decrypt(key.keyEncrypted);
    if (decrypted.length === token.length) {
      const a = Buffer.from(decrypted);
      const b = Buffer.from(token);
      if (timingSafeEqual(a, b)) return key.userId;
    }
  }
  return null;
}

/**
 * Full auth middleware: authenticate + rate limit.
 * Returns userId on success, or a 401/429 Response on failure.
 */
export async function requireMobileAuth(
  req: NextRequest
): Promise<{ userId: string } | NextResponse> {
  const userId = await authenticateMobile(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = await rateLimit("mobile", userId, { windowMs: 60_000, max: 120 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limited", retryAfter: rl.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds ?? 60) } }
    );
  }

  return { userId };
}
