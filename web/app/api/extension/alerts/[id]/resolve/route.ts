import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { db, alerts, projects, apiKeys } from "@/lib/db"
import { eq, and, inArray } from "drizzle-orm"
import { decrypt } from "@/lib/crypto"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // Auth
  const auth = req.headers.get("authorization") ?? ""
  if (!auth.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const token = auth.slice(7).trim()

  const keys = await db.select().from(apiKeys).where(eq(apiKeys.service, "desktop"))
  const keyRow = keys.find((k) => {
    const stored = Buffer.from(decrypt(k.keyEncrypted ?? ""))
    const provided = Buffer.from(token)
    if (stored.length !== provided.length) return false
    return crypto.timingSafeEqual(stored, provided)
  })
  if (!keyRow) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // Verify alert belongs to user's projects
  const userProjects = await db.select().from(projects).where(eq(projects.userId, keyRow.userId))
  const projectIds = userProjects.map((p) => p.id)

  await db
    .update(alerts)
    .set({ isRead: true, isResolved: true })
    .where(and(eq(alerts.id, id), inArray(alerts.projectId, projectIds)))

  return NextResponse.json({ ok: true })
}
