export interface CaptureConfig {
  /** DSN — "https://secret@app.inariwatch.com/capture/integration-id" or "http://localhost:9111/ingest" */
  dsn: string
  /** Environment tag (e.g. "production", "preview", "development") */
  environment?: string
  /** Release tag (e.g. "v1.2.3") */
  release?: string
  /** Log transport errors to console.warn */
  debug?: boolean
  /** Suppress all console output */
  silent?: boolean
  /** Transform or filter events before sending — return null to drop */
  beforeSend?: (event: ErrorEvent) => ErrorEvent | null
}

export interface ErrorEvent {
  fingerprint: string
  title: string
  body: string
  severity: "critical" | "warning" | "info"
  timestamp: string
  environment?: string
  release?: string
  context?: Record<string, unknown>
  request?: { method: string; url: string }
  runtime?: "nodejs" | "edge"
  routePath?: string
  routeType?: string
  /** Event type — "error" (default), "log", or "deploy" */
  eventType?: "error" | "log" | "deploy"
  /** Log level for log events */
  logLevel?: "debug" | "info" | "warn" | "error" | "fatal"
  /** Structured metadata for log events */
  metadata?: Record<string, unknown>
}

export interface ParsedDSN {
  endpoint: string
  secretKey: string
  isLocal: boolean
}
