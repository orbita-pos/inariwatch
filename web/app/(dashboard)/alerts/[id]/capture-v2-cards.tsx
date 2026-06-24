/**
 * Three tightly-scoped cards surfacing the remaining Capture SDK v2
 * payload fields:
 *
 *   - EnvironmentCard — runtime versions + memory snapshot at crash
 *   - UserContextCard  — who hit it (id + role + plan, no email)
 *   - RequestContextCard — the HTTP request that triggered the crash
 *
 * Each renders only when its slice of `correlationData` is present.
 * Together with GitContextCard + BreadcrumbsPanel (Week 2) + CorrelationCard
 * they replace the raw JSON dump that earlier covered all of these.
 *
 * All are server components (no interactivity). Narrowing happens at
 * render time so a malformed payload just hides the card — we never
 * throw on unexpected shapes.
 */

import { Server, User, Globe } from "lucide-react";

// ── Shared helpers ────────────────────────────────────────────────────────

function Card({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof Server;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <Icon className="h-3.5 w-3.5 shrink-0 text-inari-accent" aria-hidden />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-strong">
          {title}
        </h3>
      </div>
      <div className="px-4 py-3">{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 text-xs">
      <span className="w-24 shrink-0 text-fg-base/50">{label}</span>
      <span className="min-w-0 flex-1 text-fg-base break-words">{value}</span>
    </div>
  );
}

// ── Environment ───────────────────────────────────────────────────────────

interface EnvPayload {
  node?: unknown;
  node_version?: unknown;
  platform?: unknown;
  arch?: unknown;
  runtime?: unknown;
  app_version?: unknown;
  heapUsedMB?: unknown;
  heapTotalMB?: unknown;
  totalMemoryMB?: unknown;
  freeMemoryMB?: unknown;
  uptime?: unknown;
}

export function EnvironmentCard({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") return null;
  const e = data as EnvPayload;

  const nodeVer = typeof e.node === "string" ? e.node
    : typeof e.node_version === "string" ? e.node_version
    : null;
  const platform = typeof e.platform === "string" ? e.platform : null;
  const arch = typeof e.arch === "string" ? e.arch : null;
  const appVer = typeof e.app_version === "string" ? e.app_version : null;
  const runtime = typeof e.runtime === "string" ? e.runtime : null;
  const heapUsed = typeof e.heapUsedMB === "number" ? e.heapUsedMB : null;
  const heapTotal = typeof e.heapTotalMB === "number" ? e.heapTotalMB : null;
  const uptime = typeof e.uptime === "number" ? e.uptime : null;

  // If we don't have anything meaningful to show, hide the card.
  if (!nodeVer && !platform && !appVer && !runtime && heapUsed === null && uptime === null) return null;

  return (
    <Card title="Runtime Environment" icon={Server}>
      <div className="space-y-1.5">
        {(nodeVer || platform) && (
          <Row
            label="Node"
            value={
              <span className="font-mono">
                {nodeVer ?? "unknown"}
                {platform ? ` (${platform}${arch ? `/${arch}` : ""})` : ""}
              </span>
            }
          />
        )}
        {(appVer || runtime) && (
          <Row
            label="App"
            value={
              <span>
                <span className="font-mono">{appVer ?? "unknown"}</span>
                {runtime && (
                  <span className="ml-2 text-fg-base/60">runtime: {runtime}</span>
                )}
              </span>
            }
          />
        )}
        {heapUsed !== null && heapTotal !== null && (
          <Row
            label="Heap"
            value={
              <span className="tabular-nums">
                {heapUsed}<span className="text-fg-base/50"> / </span>{heapTotal} MB
                {heapUsed / heapTotal > 0.8 && (
                  <span className="ml-2 rounded bg-amber-500/15 px-1 text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                    high
                  </span>
                )}
              </span>
            }
          />
        )}
        {uptime !== null && (
          <Row
            label="Uptime"
            value={<span className="tabular-nums">{formatUptime(uptime)}</span>}
          />
        )}
      </div>
    </Card>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// ── User context ──────────────────────────────────────────────────────────

interface UserPayload {
  id?: unknown;
  role?: unknown;
  plan?: unknown;
}

export function UserContextCard({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") return null;
  const u = data as UserPayload;
  const id = typeof u.id === "string" ? u.id : null;
  if (!id) return null;
  const role = typeof u.role === "string" ? u.role : null;
  const plan = typeof u.plan === "string" ? u.plan : null;

  return (
    <Card title="Affected User" icon={User}>
      <div className="space-y-1.5">
        <Row label="ID" value={<span className="font-mono">{id}</span>} />
        {role && <Row label="Role" value={role} />}
        {plan && (
          <Row
            label="Plan"
            value={
              <span className="rounded bg-inari-accent/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-inari-accent">
                {plan}
              </span>
            }
          />
        )}
        <p className="mt-2 text-[10px] text-fg-base/40">
          Email + PII stripped by the SDK. Only id + role + plan are captured.
        </p>
      </div>
    </Card>
  );
}

// ── Request context ───────────────────────────────────────────────────────

interface RequestPayload {
  method?: unknown;
  url?: unknown;
  headers?: unknown;
  query?: unknown;
  body?: unknown;
  ip?: unknown;
}

export function RequestContextCard({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") return null;
  const r = data as RequestPayload;
  const method = typeof r.method === "string" ? r.method : null;
  const url = typeof r.url === "string" ? r.url : null;
  if (!method && !url) return null;

  const headers = r.headers && typeof r.headers === "object"
    ? (r.headers as Record<string, unknown>)
    : null;
  const query = r.query && typeof r.query === "object"
    ? (r.query as Record<string, unknown>)
    : null;
  const ip = typeof r.ip === "string" ? r.ip : null;
  const body = r.body !== undefined && r.body !== null ? r.body : null;

  return (
    <Card title="Triggering Request" icon={Globe}>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider ${methodStyle(method)}`}>
            {method ?? "GET"}
          </span>
          <span className="truncate font-mono text-xs text-fg-strong" title={url ?? undefined}>
            {url ?? "<unknown>"}
          </span>
        </div>

        {headers && Object.keys(headers).length > 0 && (
          <details className="rounded border border-line/60 bg-surface-inner px-2 py-1 text-[10px]">
            <summary className="cursor-pointer select-none text-fg-base/70">
              headers ({Object.keys(headers).length})
            </summary>
            <dl className="mt-1 space-y-0.5 text-fg-base/80">
              {Object.entries(headers).slice(0, 12).map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <dt className="w-32 shrink-0 font-mono text-fg-base/50">{k}</dt>
                  <dd className="min-w-0 flex-1 truncate font-mono">{String(v)}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}

        {query && Object.keys(query).length > 0 && (
          <Row
            label="query"
            value={
              <span className="font-mono text-[11px]">
                {Object.entries(query).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join("  ")}
              </span>
            }
          />
        )}

        {ip && <Row label="IP" value={<span className="font-mono">{ip}</span>} />}

        {body !== null && (
          <details className="rounded border border-line/60 bg-surface-inner px-2 py-1 text-[10px]">
            <summary className="cursor-pointer select-none text-fg-base/70">body</summary>
            <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-fg-base/80">
              {previewBody(body)}
            </pre>
          </details>
        )}
      </div>
    </Card>
  );
}

function methodStyle(method: string | null): string {
  if (!method) return "bg-fg-base/10 text-fg-base/70";
  switch (method.toUpperCase()) {
    case "GET":    return "bg-blue-500/15 text-blue-600 dark:text-blue-400";
    case "POST":   return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
    case "PUT":    return "bg-amber-500/15 text-amber-600 dark:text-amber-400";
    case "PATCH":  return "bg-amber-500/15 text-amber-600 dark:text-amber-400";
    case "DELETE": return "bg-red-500/15 text-red-600 dark:text-red-400";
    default:       return "bg-fg-base/10 text-fg-base/70";
  }
}

function previewBody(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 1500);
  try {
    const str = JSON.stringify(body, null, 2);
    return str.length > 1500 ? str.slice(0, 1500) + "\n...[truncated]" : str;
  } catch {
    return String(body).slice(0, 1500);
  }
}
