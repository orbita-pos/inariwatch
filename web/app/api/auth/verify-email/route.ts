import { NextRequest, NextResponse } from "next/server";
import { db, emailVerifications, users } from "@/lib/db";
import { eq, and, gt } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const start = Date.now();
  const token = request.nextUrl.searchParams.get("token");

  if (!token) {
    return NextResponse.redirect(new URL("/login?error=missing-token", request.url));
  }

  // Find valid (not expired) verification token
  const [verification] = await db
    .select()
    .from(emailVerifications)
    .where(
      and(
        eq(emailVerifications.token, token),
        gt(emailVerifications.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!verification) {
    // Constant-time jitter: normalize response time to prevent timing attacks
    const elapsed = Date.now() - start;
    if (elapsed < 200) await new Promise(r => setTimeout(r, 200 - elapsed + Math.random() * 50));
    return NextResponse.redirect(new URL("/login?error=invalid-token", request.url));
  }

  // Mark user's email as verified
  await db
    .update(users)
    .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, verification.userId));

  // Delete the used verification token
  await db
    .delete(emailVerifications)
    .where(eq(emailVerifications.id, verification.id));

  return NextResponse.redirect(new URL("/settings?verified=true", request.url));
}
