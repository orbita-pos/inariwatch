/**
 * Code Intelligence — structured logger.
 *
 * Phase 0.4 of v2 fills three blind spots in v1:
 *   - indexer.ts docstring batch failures (silently dropped)
 *   - search.ts AI rerank failures (silently fall back to RRF)
 *   - embeddings.ts Voyage→OpenAI fallback events (no signal at all)
 *
 * Without this, the v1↔v2 A/B harness in Phase 3 has nothing to compare —
 * we can't tell if v2 saved us 30% of turns or if v1 was secretly degrading
 * for half the workspaces because Voyage was 502'ing all week.
 *
 * Output: a single `console.warn` JSON line per event. Same surface used by
 * Vercel + Hetzner log aggregators. No new dep, no new env, no new wire.
 *
 * Severity model:
 *   - "warn"  — degraded but recovered (fallback fired, partial result)
 *   - "error" — failed with consequence (whole batch dropped, search empty)
 *   - "info"  — observability only (provider switch, cache hit/miss)
 */

export type CodeIntelLogSeverity = "info" | "warn" | "error";

export type CodeIntelLogEvent =
  | "embedding.fallback"
  | "embedding.failure"
  | "indexer.docstring_batch_failed"
  | "indexer.embedding_batch_failed"
  | "search.rerank_failed"
  | "search.embedding_unavailable";

export interface CodeIntelLogContext {
  /** Stable event identifier — keep in CodeIntelLogEvent so consumers can filter. */
  event: CodeIntelLogEvent;
  severity: CodeIntelLogSeverity;
  /**
   * Which engine emitted the event — defaults to "v1" (statistical retrieval).
   * Phase 1.3 introduces v2 (semantic graph); callers there pass "v2" so log
   * aggregators can filter without parsing event names.
   */
  phase?: "v1" | "v2";
  /** Repo / project / chunk identifiers when known. Strip everything else. */
  repoId?: string;
  projectId?: string;
  chunkId?: string;
  /** Active provider (voyage / openai) — never log the API key. */
  provider?: string;
  /** Free-form structured detail. Caller is responsible for not leaking PII. */
  detail?: Record<string, unknown>;
  /** Optional error — message is sanitized of bearer/sk-/ghp_ tokens. */
  error?: unknown;
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]"],
  [/sk-[A-Za-z0-9_-]{10,}/g, "[REDACTED]"],
  [/pa-[A-Za-z0-9_-]{10,}/g, "[REDACTED]"],
  [/ghp_[A-Za-z0-9]{10,}/g, "[REDACTED]"],
  [/gho_[A-Za-z0-9]{10,}/g, "[REDACTED]"],
  [/key=[^\s&"']+/gi, "key=[REDACTED]"],
];

function sanitize(value: string): string {
  let result = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function describeError(err: unknown): string | undefined {
  if (err === undefined || err === null) return undefined;
  if (err instanceof Error) return sanitize(err.message);
  if (typeof err === "string") return sanitize(err);
  try {
    return sanitize(JSON.stringify(err));
  } catch {
    return undefined;
  }
}

/**
 * Emit one structured log line for a code-intelligence event.
 * Always tagged `module=code-intelligence, phase=v1` so v2 can be filtered
 * separately when it arrives.
 */
export function logCodeIntelEvent(ctx: CodeIntelLogContext): void {
  const payload = {
    module: "code-intelligence",
    phase: ctx.phase ?? "v1",
    event: ctx.event,
    severity: ctx.severity,
    timestamp: new Date().toISOString(),
    ...(ctx.repoId ? { repoId: ctx.repoId } : {}),
    ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
    ...(ctx.chunkId ? { chunkId: ctx.chunkId } : {}),
    ...(ctx.provider ? { provider: ctx.provider } : {}),
    ...(ctx.detail ? { detail: ctx.detail } : {}),
  } as Record<string, unknown>;
  const errMsg = describeError(ctx.error);
  if (errMsg) payload.errorMessage = errMsg;

  // Single line, JSON, easy to grep / pipe to log aggregators.
  // Severity 'info' goes to console.log so it doesn't pollute warn channels.
  const line = JSON.stringify(payload);
  if (ctx.severity === "error") {
    console.error(line);
  } else if (ctx.severity === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}
