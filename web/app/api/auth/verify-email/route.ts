import { NextRequest, NextResponse } from "next/server";
import { db, emailVerifications, users } from "@/lib/db";
import { eq, and, gt } from "drizzle-orm";

export async function GET(request: NextRequest) {
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
