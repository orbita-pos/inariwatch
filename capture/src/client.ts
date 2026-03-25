import type { CaptureConfig, ErrorEvent } from "./types.js"
import { computeErrorFingerprint } from "./fingerprint.js"
import { parseDSN, createTransport, type Transport } from "./transport.js"

let globalTransport: Transport | null = null
let globalConfig: CaptureConfig | null = null
let lastReportedRelease: string | null = null

export function init(config: CaptureConfig): void {
  if (!config.dsn) {
    if (!config.silent) console.warn("[@inariwatch/capture] Missing DSN — events will be dropped")
    return
  }

  const parsed = parseDSN(config.dsn)
  globalConfig = config
  globalTransport = createTransport(config, parsed)

  // Report deploy if release is set (deploy detection)
  if (config.release && config.release !== lastReportedRelease) {
    lastReportedRelease = config.release
    reportDeploy(config.release, config.environment)
  }
}

function reportDeploy(release: string, environment?: string): void {
  if (!globalTransport || !globalConfig) return
  const transport = globalTransport
  const config = globalConfig

  computeErrorFingerprint(`deploy:${release}`, environment || "").then((fp) => {
    const event: ErrorEvent = {
      fingerprint: fp,
      title: `Deploy: ${release}`,
      body: `New release deployed: ${release}${environment ? ` (${environment})` : ""}`,
      severity: "info",
      timestamp: new Date().toISOString(),
      environment: config.environment,
      release,
      eventType: "deploy",
    }
    transport.send(event)
  })
}

export function captureException(
  error: Error,
  context?: Record<string, unknown>,
): void {
  if (!globalTransport || !globalConfig) return

  const title = `${error.name}: ${error.message}`
  const body = error.stack || title

  const event: Omit<ErrorEvent, "fingerprint"> & { fingerprint?: string } = {
    title,
    body,
    severity: "critical",
    timestamp: new Date().toISOString(),
    environment: globalConfig.environment,
    release: globalConfig.release,
    context,
    request: context?.request as ErrorEvent["request"],
    runtime: context?.runtime as ErrorEvent["runtime"],
    routePath: context?.routePath as string | undefined,
    routeType: context?.routeType as string | undefined,
  }

  // Compute fingerprint async, then send
  const transport = globalTransport
  const config = globalConfig
  computeErrorFingerprint(title, body).then((fp) => {
    const fullEvent: ErrorEvent = { ...event, fingerprint: fp }

    if (config.beforeSend) {
      const filtered = config.beforeSend(fullEvent)
      if (!filtered) return
      transport.send(filtered)
    } else {
      transport.send(fullEvent)
    }
  })
}

export function captureMessage(
  message: string,
  level: "info" | "warning" | "critical" = "info",
): void {
  if (!globalTransport || !globalConfig) return

  const transport = globalTransport
  const config = globalConfig

  computeErrorFingerprint(message, "").then((fp) => {
    const event: ErrorEvent = {
      fingerprint: fp,
      title: message,
      body: message,
      severity: level,
      timestamp: new Date().toISOString(),
      environment: config.environment,
      release: config.release,
    }

    if (config.beforeSend) {
      const filtered = config.beforeSend(event)
      if (!filtered) return
      transport.send(filtered)
    } else {
      transport.send(event)
    }
  })
}

const LOG_SEVERITY_MAP: Record<string, "critical" | "warning" | "info"> = {
  fatal: "critical",
  error: "critical",
  warn: "warning",
  info: "info",
  debug: "info",
}

export function captureLog(
  message: string,
  level: "debug" | "info" | "warn" | "error" | "fatal" = "info",
  metadata?: Record<string, unknown>,
): void {
  if (!globalTransport || !globalConfig) return

  const transport = globalTransport
  const config = globalConfig

  computeErrorFingerprint(`log:${level}:${message}`, "").then((fp) => {
    const event: ErrorEvent = {
      fingerprint: fp,
      title: `[${level.toUpperCase()}] ${message}`,
      body: metadata ? `${message}\n\n${JSON.stringify(metadata, null, 2)}` : message,
      severity: LOG_SEVERITY_MAP[level] || "info",
      timestamp: new Date().toISOString(),
      environment: config.environment,
      release: config.release,
      eventType: "log",
      logLevel: level,
      metadata,
    }

    if (config.beforeSend) {
      const filtered = config.beforeSend(event)
      if (!filtered) return
      transport.send(filtered)
    } else {
      transport.send(event)
    }
  })
}
