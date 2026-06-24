// /admin/ops Relay connections widget — v0.3 S2.
//
// Shows the WS relay's current online users (Inari Live sidecars
// connected to relay.inariwatch.com), broken down by OS + app version.
// Source of truth: the Go relay's GET /admin/connections endpoint.
//
// Auth: forwards RELAY_DISPATCH_SECRET as Bearer (same shared secret
// the user-sidecar provider uses for /dispatch). Done server-side so
// the secret never touches the browser.

import { Card, EmptyState, ErrorState } from "./card";

export const revalidate = 30;

interface ConnectionSnapshot {
  user_id: string;
  capabilities: string[];
  app_version?: string;
  os?: string;
  arch?: string;
  connected_at: string;
  last_seen: string;
}

interface RelayStatus {
  count: number;
  connections: ConnectionSnapshot[];
}

async function getRelayStatus(): Promise<
  | { ok: true; data: RelayStatus }
  | { ok: false; error: string }
> {
  const baseUrl = process.env.RELAY_URL;
  const secret = process.env.RELAY_DISPATCH_SECRET;
  if (!baseUrl || !secret) {
    return {
      ok: false,
      error: "RELAY_URL or RELAY_DISPATCH_SECRET not configured",
    };
  }
  try {
    const url = baseUrl.replace(/\/$/, "") + "/admin/connections";
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${secret}` },
      // Server component runs on Vercel/Hetzner — no caching at the
      // edge for ops data.
      cache: "no-store",
      // 5s budget so a slow Hetzner box doesn't hang the /admin/ops
      // page; the Suspense skeleton will surface in the meantime.
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return {
        ok: false,
        error: `relay returned ${res.status}`,
      };
    }
    const body = (await res.json()) as RelayStatus;
    return { ok: true, data: body };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function bucket(connections: ConnectionSnapshot[]) {
  const byOS = new Map<string, number>();
  const byVersion = new Map<string, number>();
  for (const c of connections) {
    const os = c.os || "unknown";
    byOS.set(os, (byOS.get(os) ?? 0) + 1);
    const v = c.app_version || "unknown";
    byVersion.set(v, (byVersion.get(v) ?? 0) + 1);
  }
  return {
    osRows: [...byOS.entries()].sort((a, b) => b[1] - a[1]),
    versionRows: [...byVersion.entries()].sort((a, b) => b[1] - a[1]),
  };
}

function ageSeconds(ts: string): number {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

function formatAge(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export async function RelayWidget() {
  const r = await getRelayStatus();
  return (
    <Card
      title="Relay connections"
      subtitle="Inari Live sidecars on wss://relay.inariwatch.com"
    >
      {!r.ok ? (
        <ErrorState message={r.error} />
      ) : r.data.count === 0 ? (
        <EmptyState message="No sidecars connected. Inari Live registers on app boot." />
      ) : (
        <RelayBody data={r.data} />
      )}
    </Card>
  );
}

function RelayBody({ data }: { data: RelayStatus }) {
  const { osRows, versionRows } = bucket(data.connections);
  const stalest = data.connections
    .map((c) => ageSeconds(c.last_seen))
    .reduce((a, b) => Math.max(a, b), 0);

  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-baseline justify-between">
        <span className="text-fg-base/60">online users</span>
        <span className="font-mono text-base text-fg-strong">
          {data.count.toLocaleString()}
        </span>
      </div>

      <div className="border-t border-line pt-3">
        <div className="text-[11px] uppercase tracking-wide text-fg-base/40">
          by OS
        </div>
        <div className="mt-1 space-y-1 font-mono">
          {osRows.map(([os, count]) => (
            <div key={os} className="flex justify-between">
              <span className="text-fg-base/60">{os}</span>
              <span>{count.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="border-t border-line pt-3">
        <div className="text-[11px] uppercase tracking-wide text-fg-base/40">
          by app version
        </div>
        <div className="mt-1 space-y-1 font-mono">
          {versionRows.slice(0, 6).map(([v, count]) => (
            <div key={v} className="flex justify-between">
              <span className="text-fg-base/60">{v}</span>
              <span>{count.toLocaleString()}</span>
            </div>
          ))}
          {versionRows.length > 6 ? (
            <div className="text-fg-base/40">
              +{versionRows.length - 6} more versions
            </div>
          ) : null}
        </div>
      </div>

      <div className="border-t border-line pt-3 flex justify-between font-mono text-fg-base/60">
        <span>stalest last-seen</span>
        <span className={stalest > 90 ? "text-amber-500" : ""}>
          {formatAge(stalest)}
          {stalest > 90 ? " ⚠" : ""}
        </span>
      </div>
    </div>
  );
}
