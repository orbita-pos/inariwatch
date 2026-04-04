/**
 * Extension auth — shared across all /api/extension/* endpoints.
 * Accepts both "extension" and "mobile" service tokens (so existing mobile tokens work).
 */

import { db, apiKeys } from "@/lib/db";
import { eq, or } from "drizzle-orm";
import { decrypt } from "@/lib/crypto";
import { rateLimit } from "@/lib/auth-rate-limit";
import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";

export async function authenticateExtension(req: NextRequest): Promise<string | null> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;

  // Accept both extension and mobile tokens
  const keys = await db
    .select()
    .from(apiKeys)
    .where(or(eq(apiKeys.service, "extension"), eq(apiKeys.service, "mobile")))
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

export async function requireExtensionAuth(
  req: NextRequest
): Promise<{ userId: string } | NextResponse> {
  const userId = await authenticateExtension(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = await rateLimit("extension", userId, { windowMs: 60_000, max: 120 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limited", retryAfter: rl.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds ?? 60) } }
    );
  }

  return { userId };
}
