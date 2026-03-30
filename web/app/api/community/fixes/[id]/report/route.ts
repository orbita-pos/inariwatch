import { NextRequest, NextResponse } from "next/server";
import { db, communityFixes } from "@/lib/db";
import { eq, sql } from "drizzle-orm";

/**
 * POST /api/community/fixes/:id/report
 *
 * Report whether a fix worked or not. Atomically increments success/failure
 * counters. No auth required — anyone consuming the fix can report back.
 *
 * Body: { worked: boolean }
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: { worked?: unknown };
  try { body = await req.json(); } catch { body = {}; }

  if (typeof body.worked !== "boolean") {
    return NextResponse.json(
      { error: "worked (boolean) required" },
      { status: 400, headers: CORS },
    );
  }

  const updated = await db
    .update(communityFixes)
    .set(
      body.worked
        ? {
            successCount:      sql`${communityFixes.successCount} + 1`,
            totalApplications: sql`${communityFixes.totalApplications} + 1`,
            updatedAt:         new Date(),
          }
        : {
            failureCount:      sql`${communityFixes.failureCount} + 1`,
            totalApplications: sql`${communityFixes.totalApplications} + 1`,
            updatedAt:         new Date(),
          },
    )
    .where(eq(communityFixes.id, id))
    .returning({ id: communityFixes.id });

  if (updated.length === 0) {
    return NextResponse.json({ error: "Fix not found" }, { status: 404, headers: CORS });
  }

  return NextResponse.json({ ok: true }, { headers: CORS });
}
