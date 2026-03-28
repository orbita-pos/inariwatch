import * as http from "http"
import { randomUUID } from "crypto"
import type { AlertStore } from "./store.js"
import type { ExtensionAlert } from "./types.js"

const MAX_BODY_BYTES = 65536 // 64KB
const VALID_SEVERITIES = new Set(["critical", "warning", "info"])

/** Local HTTP server that receives errors from @inariwatch/capture in local mode */
export class LocalServer {
  private server: http.Server | null = null
  private token: string | null = null

  constructor(private store: AlertStore) {}

  /** Get the ephemeral auth token (set INARIWATCH_LOCAL_TOKEN to this value) */
  getToken(): string | null {
    return this.token
  }

  start(port: number): void {
    if (this.server) return

    // Generate ephemeral token for this session
    this.token = randomUUID()

    this.server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/ingest") {
        // Auth: require ephemeral token
        const reqToken = req.headers["x-inariwatch-local"] as string | undefined
        if (reqToken !== this.token) {
          res.writeHead(401, { "Content-Type": "application/json" })
          res.end('{"error":"unauthorized"}')
          return
        }

        // Body size limit
        let body = ""
        let size = 0

        req.on("data", (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_BODY_BYTES) {
            res.writeHead(413, { "Content-Type": "application/json" })
            res.end('{"error":"payload too large"}')
            req.destroy()
            return
          }
          body += chunk.toString()
        })

        req.on("end", () => {
          if (size > MAX_BODY_BYTES) return // already responded

          try {
            const event = JSON.parse(body)
            const alert = validateAndConvert(event)
            if (!alert) {
              res.writeHead(400, { "Content-Type": "application/json" })
              res.end('{"error":"invalid event structure"}')
              return
            }
            this.store.add(alert)
            res.writeHead(200, { "Content-Type": "application/json" })
            res.end('{"ok":true}')
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" })
            res.end('{"error":"invalid JSON"}')
          }
        })
        return
      }

      // Health check
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end('{"ok":true}')
        return
      }

      res.writeHead(404)
      res.end()
    })

    this.server.listen(port, "127.0.0.1", () => {
      console.log(`[InariWatch] Local capture server on http://127.0.0.1:${port}`)
      console.log(`[InariWatch] Local token: ${this.token}`)
      console.log(`[InariWatch] Set INARIWATCH_LOCAL_TOKEN=${this.token} in your app`)
    })

    this.server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.warn(`[InariWatch] Port ${port} in use — local mode disabled`)
      }
    })
  }

  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
      this.token = null
    }
  }
}

/** Validate event structure and convert to ExtensionAlert. Returns null if invalid. */
function validateAndConvert(event: unknown): ExtensionAlert | null {
  if (!event || typeof event !== "object") return null

  const e = event as Record<string, unknown>

  const title = typeof e.title === "string" ? e.title.slice(0, 500) : null
  if (!title) return null

  const body = typeof e.body === "string" ? e.body.slice(0, 10000) : ""
  const severity = typeof e.severity === "string" && VALID_SEVERITIES.has(e.severity)
    ? (e.severity as ExtensionAlert["severity"])
    : "critical"

  let timestamp = new Date().toISOString()
  if (typeof e.timestamp === "string") {
    const parsed = new Date(e.timestamp)
    if (!isNaN(parsed.getTime())) timestamp = parsed.toISOString()
  }

  const fingerprint = typeof e.fingerprint === "string" ? e.fingerprint.slice(0, 128) : null

  return {
    id: fingerprint || randomUUID(),
    title,
    body,
    severity,
    aiReasoning: null,
    postmortem: null,
    fingerprint,
    isRead: false,
    isResolved: false,
    sourceIntegrations: ["capture"],
    projectName: "local",
    createdAt: timestamp,
    source: "local",
  }
}
