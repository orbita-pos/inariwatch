/**
 * Format Capture SDK v2 fields (git + breadcrumbs) from
 * `alerts.correlationData` into prompt-friendly text for
 * RemediationContext.
 *
 * These fields are populated by @inariwatch/capture >= 0.9.0 at the
 * browser or Node.js runtime where the error fired. The webhook
 * handler stashes them verbatim in `alerts.correlationData.{git,
 * breadcrumbs}`; this module shapes them for the LLM.
 *
 * Why text-shaped (not JSON): the prompt already concatenates many
 * context sections. Compact human-readable text minimizes token spend
 * while keeping the AI's diagnosis flow intact.
 */

interface CaptureGit {
  commit?: unknown;
  branch?: unknown;
  message?: unknown;
  timestamp?: unknown;
  dirty?: unknown;
}

interface CaptureBreadcrumb {
  timestamp?: unknown;
  category?: unknown;
  level?: unknown;
  message?: unknown;
  data?: unknown;
}

/**
 * Build the GIT CONTEXT string.
 *
 * Output shape:
 *   commit: <sha7> on <branch> ("<message>")
 *   committed: <iso>
 *   workdir: <clean|dirty>
 *
 * Returns null when no usable git data is present — the prompt section
 * is omitted entirely rather than padding with empty strings.
 */
export function formatGitContext(git: unknown): string | null {
  if (!git || typeof git !== "object") return null;
  const g = git as CaptureGit;
  const commit = typeof g.commit === "string" ? g.commit : null;
  if (!commit) return null;

  const sha7 = commit.slice(0, 7);
  const branch = typeof g.branch === "string" ? g.branch : "unknown";
  const message = typeof g.message === "string" ? g.message.slice(0, 120) : "";
  const timestamp = typeof g.timestamp === "string" ? g.timestamp : "";
  const dirty = g.dirty === true;

  const lines: string[] = [];
  lines.push(`commit: ${sha7} on ${branch}${message ? ` ("${message}")` : ""}`);
  if (timestamp) lines.push(`committed: ${timestamp}`);
  lines.push(`workdir: ${dirty ? "dirty (uncommitted changes)" : "clean"}`);
  return lines.join("\n");
}

/**
 * Build the BREADCRUMBS context string.
 *
 * Capped at 30 crumbs (the SDK's own ring-buffer size) and at 2500
 * characters total (hard cap at the call site too). Each line shows:
 *   <relativeMs>ms <category>/<level>: <message>
 *
 * `relativeMs` is "time before the crash" — we compute it from the
 * last crumb's timestamp backwards, which is more useful for debugging
 * than absolute ISO timestamps.
 */
export function formatBreadcrumbsContext(breadcrumbs: unknown): string | null {
  if (!Array.isArray(breadcrumbs) || breadcrumbs.length === 0) return null;

  // Keep only the last 30 — matches the SDK's MAX_BREADCRUMBS.
  const crumbs = breadcrumbs.slice(-30) as CaptureBreadcrumb[];

  // Anchor the relative-time axis at the LAST crumb's timestamp (the
  // moment closest to the crash). If timestamps are malformed, degrade
  // to the index-based order.
  const lastTsMs = parseTsMs(crumbs[crumbs.length - 1]?.timestamp);

  const lines: string[] = crumbs.map((c) => {
    const tsMs = parseTsMs(c.timestamp);
    const deltaMs = lastTsMs != null && tsMs != null ? lastTsMs - tsMs : null;
    const prefix = deltaMs !== null ? `-${String(deltaMs).padStart(6, " ")}ms` : "     ??ms";
    const cat = typeof c.category === "string" ? c.category : "custom";
    const level = typeof c.level === "string" ? c.level : "info";
    const msg = typeof c.message === "string" ? c.message.slice(0, 200) : "";
    return `${prefix}  ${cat}/${level}: ${msg}`;
  });

  return lines.join("\n");
}

function parseTsMs(ts: unknown): number | null {
  if (typeof ts !== "string") return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}
