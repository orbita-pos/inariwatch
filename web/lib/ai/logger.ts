/**
 * Structured logger for the AI remediation pipeline.
 *
 * Outputs JSON lines to stdout — Vercel captures these automatically.
 * Zero dependencies. Each log includes sessionId for correlation.
 */

type LogLevel = "info" | "warn" | "error";

type LogContext = Record<string, unknown>;

function log(level: LogLevel, message: string, context?: LogContext) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...context,
  };
  // JSON line to stdout — Vercel Log Drain picks these up
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify(entry)
  );
}

/**
 * Create a scoped logger for a remediation session.
 * All entries include `sessionId` for filtering/correlation.
 */
export function createSessionLogger(sessionId: string) {
  return {
    info: (msg: string, ctx?: LogContext) => log("info", msg, { sessionId, ...ctx }),
    warn: (msg: string, ctx?: LogContext) => log("warn", msg, { sessionId, ...ctx }),
    error: (msg: string, err?: unknown, ctx?: LogContext) =>
      log("error", msg, {
        sessionId,
        error: err instanceof Error ? err.message : String(err ?? ""),
        ...(err instanceof Error && err.stack ? { stack: err.stack.split("\n").slice(0, 5).join("\n") } : {}),
        ...ctx,
      }),
  };
}

/**
 * Standalone logger for code without a session (e.g., context-gatherer).
 */
export const aiLog = {
  info: (msg: string, ctx?: LogContext) => log("info", msg, ctx),
  warn: (msg: string, ctx?: LogContext) => log("warn", msg, ctx),
  error: (msg: string, err?: unknown, ctx?: LogContext) =>
    log("error", msg, {
      error: err instanceof Error ? err.message : String(err ?? ""),
      ...(err instanceof Error && err.stack ? { stack: err.stack.split("\n").slice(0, 5).join("\n") } : {}),
      ...ctx,
    }),
};
