/**
 * Scope — request context, user context, and tags.
 * Uses AsyncLocalStorage for per-request isolation in Node.js.
 * Falls back to global state in edge runtime.
 */

let asyncStorage: any = null
try {
  const { AsyncLocalStorage } = require("node:async_hooks")
  asyncStorage = new AsyncLocalStorage()
} catch {
  // Edge runtime — fallback to global
}

interface Scope {
  user?: { id?: string; role?: string }
  tags?: Record<string, string>
  requestContext?: {
    method: string
    url: string
    headers?: Record<string, string>
    query?: Record<string, string>
    body?: unknown
    ip?: string
  }
}

let globalScope: Scope = {}

const REDACT_HEADERS = new Set([
  "authorization", "cookie", "set-cookie", "x-api-key",
  "x-auth-token", "x-csrf-token", "proxy-authorization",
])

function getScope(): Scope {
  if (asyncStorage) {
    return asyncStorage.getStore() ?? globalScope
  }
  return globalScope
}

// ── Public API ──────────────────────────────────────────────────────────────

export function setUser(user: { id?: string; email?: string; role?: string }): void {
  // Strip email by default (PII) — only keep id + role
  const safe = { id: user.id, role: user.role }
  const scope = getScope()
  scope.user = safe
}

export function setTag(key: string, value: string): void {
  const scope = getScope()
  if (!scope.tags) scope.tags = {}
  scope.tags[key] = value
}

export function setRequestContext(ctx: {
  method: string
  url: string
  headers?: Record<string, string>
  query?: Record<string, string>
  body?: unknown
  ip?: string
}): void {
  const scope = getScope()

  // Redact sensitive headers
  const safeHeaders: Record<string, string> = {}
  if (ctx.headers) {
    for (const [k, v] of Object.entries(ctx.headers)) {
      safeHeaders[k] = REDACT_HEADERS.has(k.toLowerCase()) ? "[REDACTED]" : v
    }
  }

  // Truncate body
  let safeBody = ctx.body
  if (typeof safeBody === "string" && safeBody.length > 1024) {
    safeBody = safeBody.slice(0, 1024) + "...[truncated]"
  }

  scope.requestContext = {
    method: ctx.method,
    url: ctx.url,
    headers: Object.keys(safeHeaders).length > 0 ? safeHeaders : undefined,
    query: ctx.query,
    body: safeBody,
    ip: ctx.ip,
  }
}

export function getUser(): Scope["user"] {
  return getScope().user
}

export function getTags(): Scope["tags"] {
  return getScope().tags
}

export function getRequestContext(): Scope["requestContext"] {
  return getScope().requestContext
}

/**
 * Run a function with an isolated scope (for per-request isolation).
 * Use in middleware: runWithScope(() => handleRequest(req, res))
 */
export function runWithScope<T>(fn: () => T): T {
  if (asyncStorage) {
    return asyncStorage.run({}, fn)
  }
  return fn()
}
