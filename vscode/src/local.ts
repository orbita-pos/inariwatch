import * as http from "http"
import { randomUUID } from "crypto"
import type { AlertStore } from "./store.js"
import type { ExtensionAlert } from "./types.js"

/** Local HTTP server that receives errors from @inariwatch/capture in local mode */
export class LocalServer {
  private server: http.Server | null = null

  constructor(private store: AlertStore) {}

  start(port: number): void {
    if (this.server) return

    this.server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/ingest") {
        let body = ""
        req.on("data", (chunk: Buffer) => { body += chunk.toString() })
        req.on("end", () => {
          try {
            const event = JSON.parse(body)
            const alert = captureEventToAlert(event)
            this.store.add(alert)
            res.writeHead(200, { "Content-Type": "application/json" })
            res.end('{"ok":true}')
          } catch {
            res.writeHead(400)
            res.end('{"error":"invalid payload"}')
          }
        })
        return
      }

      // Health check
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200)
        res.end('{"ok":true}')
        return
      }

      res.writeHead(404)
      res.end()
    })

    this.server.listen(port, "127.0.0.1", () => {
      console.log(`[InariWatch] Local capture server on http://127.0.0.1:${port}`)
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
    }
  }
}

function captureEventToAlert(event: Record<string, unknown>): ExtensionAlert {
  return {
    id: (event.fingerprint as string) || randomUUID(),
    title: (event.title as string) || "Unknown error",
    body: (event.body as string) || "",
    severity: (event.severity as ExtensionAlert["severity"]) || "critical",
    aiReasoning: null,
    postmortem: null,
    fingerprint: (event.fingerprint as string) || null,
    isRead: false,
    isResolved: false,
    sourceIntegrations: ["capture"],
    projectName: "local",
    createdAt: (event.timestamp as string) || new Date().toISOString(),
    source: "local",
  }
}
