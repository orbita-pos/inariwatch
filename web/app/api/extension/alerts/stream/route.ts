import crypto from "crypto"
import { db, alerts, projects, apiKeys } from "@/lib/db"
import { desc, inArray, eq } from "drizzle-orm"
import { decrypt } from "@/lib/crypto"
import { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  // Bearer token auth
  const auth = req.headers.get("authorization") ?? ""
  if (!auth.startsWith("Bearer ")) {
    return new Response("Unauthorized", { status: 401 })
  }
  const token = auth.slice(7).trim()

  const keys = await db.select().from(apiKeys).where(eq(apiKeys.service, "desktop"))
  const keyRow = keys.find((k) => {
    const stored = Buffer.from(decrypt(k.keyEncrypted ?? ""))
    const provided = Buffer.from(token)
    if (stored.length !== provided.length) return false
    return crypto.timingSafeEqual(stored, provided)
  })
  if (!keyRow) return new Response("Unauthorized", { status: 401 })

  // Get user's projects
  const userProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.userId, keyRow.userId))

  const projectIds = userProjects.map((p) => p.id)
  const projectNameMap = new Map(userProjects.map((p) => [p.id, p.name]))

  const encoder = new TextEncoder()
  let closed = false

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode("event: connected\ndata: {}\n\n"))

      let lastCheckTime = new Date()

      const interval = setInterval(async () => {
        if (closed) {
          clearInterval(interval)
          return
        }

        try {
          if (projectIds.length === 0) return

          const newAlerts = await db
            .select()
            .from(alerts)
            .where(inArray(alerts.projectId, projectIds))
            .orderBy(desc(alerts.createdAt))
            .limit(10)

          const recent = newAlerts.filter((a) => a.createdAt && a.createdAt > lastCheckTime)

          for (const a of recent) {
            const data = JSON.stringify({
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
            })
            controller.enqueue(encoder.encode(`data: ${data}\n\n`))
          }

          if (recent.length > 0) lastCheckTime = new Date()

          controller.enqueue(encoder.encode(": heartbeat\n\n"))
        } catch {
          // Ignore polling errors
        }
      }, 10000)

      const checkClosed = setInterval(() => {
        if (closed) {
          clearInterval(interval)
          clearInterval(checkClosed)
          try { controller.close() } catch {}
        }
      }, 1000)
    },
    cancel() {
      closed = true
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  })
}
