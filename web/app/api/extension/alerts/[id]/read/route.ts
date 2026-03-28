import { NextRequest, NextResponse } from "next/server"
import { db, alerts } from "@/lib/db"
import { eq, and, inArray } from "drizzle-orm"
import { authenticateExtensionToken, unauthorized, forbidden, badRequest, isValidUUID } from "@/lib/auth-extension"
import { rateLimit } from "@/lib/auth-rate-limit"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const auth = await authenticateExtensionToken(req)
  if (!auth) return unauthorized()

  // Rate limit: 30 req/min per user
  const rl = await rateLimit("ext-read", auth.userId, { windowMs: 60_000, max: 30 })
  if (!rl.allowed) {
    return NextResponse.json({ error: "Rate limited" }, { status: 429 })
  }

  if (!isValidUUID(id)) return badRequest("Invalid alert ID")
  if (auth.projectIds.length === 0) return forbidden("No projects")

  await db
    .update(alerts)
    .set({ isRead: true })
    .where(and(eq(alerts.id, id), inArray(alerts.projectId, auth.projectIds)))

  return NextResponse.json({ ok: true })
}
