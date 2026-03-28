import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { db, alerts, projects, apiKeys } from "@/lib/db"
import { eq, desc, inArray, and } from "drizzle-orm"
import { decrypt } from "@/lib/crypto"

async function authenticateToken(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  if (!auth.startsWith("Bearer ")) return null
  const token = auth.slice(7).trim()
  if (!token) return null

  const keys = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.service, "desktop"))

  const keyRow = keys.find((k) => {
    const stored = Buffer.from(decrypt(k.keyEncrypted ?? ""))
    const provided = Buffer.from(token)
    if (stored.length !== provided.length) return false
    return crypto.timingSafeEqual(stored, provided)
  })

  return keyRow ?? null
}

export async function GET(req: NextRequest) {
  const keyRow = await authenticateToken(req)
  if (!keyRow) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const userProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.userId, keyRow.userId))

  if (userProjects.length === 0) return NextResponse.json([])

  const projectIds = userProjects.map((p) => p.id)
  const projectNameMap = new Map(userProjects.map((p) => [p.id, p.name]))

  const rows = await db
    .select()
    .from(alerts)
    .where(and(
      inArray(alerts.projectId, projectIds),
      eq(alerts.isResolved, false),
    ))
    .orderBy(desc(alerts.createdAt))
    .limit(50)

  const result = rows.map((a) => ({
    id: a.id,
    title: a.title,
    body: a.body,
    severity: a.severity,
    aiReasoning: a.aiReasoning,
    postmortem: a.postmortem,
    fingerprint: a.fingerprint,
    isRead: a.isRead,
    isResolved: a.isResolved,
    sourceIntegrations: a.sourceIntegrations,
    projectName: projectNameMap.get(a.projectId) ?? "Unknown",
    createdAt: a.createdAt?.toISOString(),
  }))

  return NextResponse.json(result)
}
