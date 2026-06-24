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

// ── Week 3 formatters: env + user + request ────────────────────────────────

interface CaptureEnv {
  node?: unknown;
  node_version?: unknown;
  platform?: unknown;
  arch?: unknown;
  runtime?: unknown;
  app_version?: unknown;
  heapUsedMB?: unknown;
  heapTotalMB?: unknown;
  uptime?: unknown;
}

/**
 * Build the RUNTIME ENVIRONMENT string. Combines SDK-emitted fields
 * (node/platform/arch + memory snapshot) with user-provided app metadata
 * (app_version, runtime). Returns null when no usable env data exists.
 *
 * Output example:
 *   node: v20.11.1 (linux/x64)
 *   app: 2.4.0-rc1 (runtime: node)
 *   heap: 145/256 MB  uptime: 3812s
 */
export function formatEnvContext(env: unknown): string | null {
  if (!env || typeof env !== "object") return null;
  const e = env as CaptureEnv;
  const lines: string[] = [];

  // Accept both `node` (SDK-native) and `node_version` (user-supplied
  // metadata) — they're semantically identical.
  const nodeVer = typeof e.node === "string" ? e.node
    : typeof e.node_version === "string" ? e.node_version
    : null;
  const platform = typeof e.platform === "string" ? e.platform : null;
  const arch = typeof e.arch === "string" ? e.arch : null;
  if (nodeVer || platform) {
    const p = [platform, arch].filter(Boolean).join("/");
    lines.push(`node: ${nodeVer ?? "unknown"}${p ? ` (${p})` : ""}`);
  }

  const appVer = typeof e.app_version === "string" ? e.app_version : null;
  const runtime = typeof e.runtime === "string" ? e.runtime : null;
  if (appVer || runtime) {
    lines.push(`app: ${appVer ?? "unknown"}${runtime ? ` (runtime: ${runtime})` : ""}`);
  }

  const heapUsed = typeof e.heapUsedMB === "number" ? e.heapUsedMB : null;
  const heapTotal = typeof e.heapTotalMB === "number" ? e.heapTotalMB : null;
  const uptime = typeof e.uptime === "number" ? e.uptime : null;
  if (heapUsed !== null || uptime !== null) {
    const parts: string[] = [];
    if (heapUsed !== null && heapTotal !== null) parts.push(`heap: ${heapUsed}/${heapTotal} MB`);
    if (uptime !== null) parts.push(`uptime: ${uptime}s`);
    lines.push(parts.join("  "));
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

interface CaptureUser {
  id?: unknown;
  role?: unknown;
  plan?: unknown;
}

export function formatUserContext(user: unknown): string | null {
  if (!user || typeof user !== "object") return null;
  const u = user as CaptureUser;
  const id = typeof u.id === "string" ? u.id : null;
  if (!id) return null;
  const parts: string[] = [`id: ${id}`];
  if (typeof u.role === "string") parts.push(`role: ${u.role}`);
  if (typeof u.plan === "string") parts.push(`plan: ${u.plan}`);
  return parts.join("  ");
}

interface CaptureRequest {
  method?: unknown;
  url?: unknown;
  headers?: unknown;
  query?: unknown;
  body?: unknown;
  ip?: unknown;
}

/**
 * Build the REQUEST CONTEXT string.
 *
 * Output:
 *   POST https://api.example.com/checkout
 *   headers: content-type=application/json, user-agent=Mozilla/5.0...
 *   query: user_id=u_123, plan=pro
 *   body: {"amount":5000,"currency":"usd"}
 *
 * Headers/body are already redacted server-side by the SDK. We apply
 * an additional 1500-char cap here since the prompt budget is shared.
 */
export function formatRequestContext(req: unknown): string | null {
  if (!req || typeof req !== "object") return null;
  const r = req as CaptureRequest;
  const method = typeof r.method === "string" ? r.method : null;
  const url = typeof r.url === "string" ? r.url : null;
  if (!method && !url) return null;

  const lines: string[] = [];
  if (method || url) lines.push(`${method ?? "GET"} ${url ?? "<unknown>"}`);

  if (r.headers && typeof r.headers === "object") {
    const h = r.headers as Record<string, unknown>;
    const headerLine = Object.entries(h)
      .filter(([, v]) => typeof v === "string")
      .slice(0, 8)
      .map(([k, v]) => `${k}=${String(v).slice(0, 80)}`)
      .join(", ");
    if (headerLine) lines.push(`headers: ${headerLine}`);
  }

  if (r.query && typeof r.query === "object") {
    const q = r.query as Record<string, unknown>;
    const queryLine = Object.entries(q)
      .filter(([, v]) => typeof v === "string")
      .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`)
      .join(", ");
    if (queryLine) lines.push(`query: ${queryLine}`);
  }

  if (r.body !== undefined && r.body !== null) {
    let bodyStr: string;
    try {
      bodyStr = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    } catch {
      bodyStr = "<unserializable>";
    }
    lines.push(`body: ${bodyStr.slice(0, 600)}${bodyStr.length > 600 ? "..." : ""}`);
  }

  return lines.join("\n");
}
