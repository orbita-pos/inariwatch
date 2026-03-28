import { NextRequest, NextResponse } from "next/server"
import { db, alerts } from "@/lib/db"
import { desc, inArray, eq, and } from "drizzle-orm"
import { authenticateExtensionToken, unauthorized } from "@/lib/auth-extension"
import { rateLimit } from "@/lib/auth-rate-limit"

export async function GET(req: NextRequest) {
  const auth = await authenticateExtensionToken(req)
  if (!auth) return unauthorized()

  // Rate limit: 60 req/min per user
  const rl = await rateLimit("ext-alerts", auth.userId, { windowMs: 60_000, max: 60 })
  if (!rl.allowed) {
    return NextResponse.json({ error: "Rate limited" }, { status: 429 })
  }

  if (auth.projectIds.length === 0) return NextResponse.json([])

  const rows = await db
    .select()
    .from(alerts)
    .where(and(
      inArray(alerts.projectId, auth.projectIds),
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
    projectName: "project",
    createdAt: a.createdAt?.toISOString(),
  }))

  return NextResponse.json(result)
}
