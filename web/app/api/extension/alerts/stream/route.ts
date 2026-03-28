import { db, alerts } from "@/lib/db"
import { desc, inArray } from "drizzle-orm"
import { NextRequest } from "next/server"
import { authenticateExtensionToken } from "@/lib/auth-extension"
import { rateLimit } from "@/lib/auth-rate-limit"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const MAX_CONNECTION_MS = 30 * 60 * 1000 // 30 minutes max
const POLL_INTERVAL_MS = 10_000

// Per-user connection tracking (in-memory, resets on deploy)
const activeConnections = new Map<string, number>()
const MAX_CONNECTIONS_PER_USER = 5

export async function GET(req: NextRequest) {
  const auth = await authenticateExtensionToken(req)
  if (!auth) return new Response("Unauthorized", { status: 401 })

  // Rate limit: 5 stream connections per minute
  const rl = await rateLimit("ext-stream", auth.userId, { windowMs: 60_000, max: 5 })
  if (!rl.allowed) return new Response("Rate limited", { status: 429 })

  // Check concurrent connections
  const current = activeConnections.get(auth.userId) ?? 0
  if (current >= MAX_CONNECTIONS_PER_USER) {
    return new Response("Too many connections", { status: 429 })
  }
  activeConnections.set(auth.userId, current + 1)

  const projectIds = auth.projectIds
  const encoder = new TextEncoder()
  let closed = false
  const startTime = Date.now()

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode("event: connected\ndata: {}\n\n"))

      let lastCheckTime = new Date()

      const interval = setInterval(async () => {
        // Max connection duration
        if (Date.now() - startTime > MAX_CONNECTION_MS) {
          closed = true
          clearInterval(interval)
          try { controller.close() } catch {}
          return
        }

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
              fingerprint: a.fingerprint,
              isRead: a.isRead,
              isResolved: a.isResolved,
              sourceIntegrations: a.sourceIntegrations,
              createdAt: a.createdAt?.toISOString(),
            })
            controller.enqueue(encoder.encode(`data: ${data}\n\n`))
          }

          if (recent.length > 0) lastCheckTime = new Date()

          controller.enqueue(encoder.encode(": heartbeat\n\n"))
        } catch {
          // Ignore polling errors
        }
      }, POLL_INTERVAL_MS)

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
      // Decrement connection count
      const count = activeConnections.get(auth.userId) ?? 1
      activeConnections.set(auth.userId, Math.max(0, count - 1))
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
