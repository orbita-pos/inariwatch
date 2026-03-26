import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, communityFixes, fixRatings } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * POST /api/patterns/rate
 *
 * Rate a community fix. Requires session auth (web) or Bearer CRON_SECRET (CLI).
 */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const auth = req.headers.get("authorization");
  const validBearer = CRON_SECRET && auth
    && Buffer.from(`Bearer ${CRON_SECRET}`).length === Buffer.from(auth).length
    && crypto.timingSafeEqual(Buffer.from(`Bearer ${CRON_SECRET}`), Buffer.from(auth));
  if (!session?.user && !validBearer) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: {
    fixId: string;
    userId?: string;
    worked: boolean;
    rating?: number;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.fixId || typeof body.worked !== "boolean") {
    return NextResponse.json({ error: "fixId and worked are required" }, { status: 400 });
  }

  if (body.rating !== undefined && (body.rating < 1 || body.rating > 5)) {
    return NextResponse.json({ error: "rating must be 1-5" }, { status: 400 });
  }

  // Verify fix exists
  const [fix] = await db
    .select()
    .from(communityFixes)
    .where(eq(communityFixes.id, body.fixId))
    .limit(1);

  if (!fix) {
    return NextResponse.json({ error: "Fix not found" }, { status: 404 });
  }

  // Upsert rating (one per user per fix)
  if (body.userId) {
    const [existing] = await db
      .select()
      .from(fixRatings)
      .where(
        and(
          eq(fixRatings.fixId, body.fixId),
          eq(fixRatings.userId, body.userId)
        )
      )
      .limit(1);

    if (existing) {
      // Update existing rating — adjust counts
      const wasWorked = existing.worked;
      await db
        .update(fixRatings)
        .set({ worked: body.worked, rating: body.rating ?? existing.rating })
        .where(eq(fixRatings.id, existing.id));

      // Adjust success/failure counts if worked status changed
      if (wasWorked !== body.worked) {
        await db
          .update(communityFixes)
          .set({
            successCount: fix.successCount + (body.worked ? 1 : -1),
            failureCount: fix.failureCount + (body.worked ? -1 : 1),
            updatedAt: new Date(),
          })
          .where(eq(communityFixes.id, body.fixId));
      }

      return NextResponse.json({ action: "updated" });
    }
  }

  // New rating
  await db.insert(fixRatings).values({
    fixId: body.fixId,
    userId: body.userId ?? null,
    worked: body.worked,
    rating: body.rating ?? null,
  });

  // Update fix counts
  await db
    .update(communityFixes)
    .set({
      successCount: fix.successCount + (body.worked ? 1 : 0),
      failureCount: fix.failureCount + (body.worked ? 0 : 1),
      totalApplications: fix.totalApplications + 1,
      updatedAt: new Date(),
    })
    .where(eq(communityFixes.id, body.fixId));

  return NextResponse.json({ action: "created" });
}
