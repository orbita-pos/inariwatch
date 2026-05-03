// /admin/ops Code Intelligence v1 vs v2 Shadow widget — Phase 1.7 of v2.
//
// Renders the A/B comparison surfaced by `code_intel_shadow_log` rows that
// the service-layer dispatcher writes when CODE_INTEL_V2=shadow. Drives
// the Phase 3 cutover decision.

import { Card, EmptyState, ErrorState } from "./card";
import { headers } from "next/headers";

export const revalidate = 60;

interface ShadowStats {
  windowHours: number;
  totalCalls: number;
  v1: { p50Ms: number; p95Ms: number; errors: number };
  v2: { p50Ms: number; p95Ms: number; errors: number; emptyResultCount: number };
  divergence: { count: number; pct: number };
  topDiverging: Array<{
    query: string;
    v1Top: string[];
    v2Top: string[];
    createdAt: string;
  }>;
}

async function getShadow(): Promise<
  { ok: true; data: ShadowStats } | { ok: false; error: string }
> {
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto =
    h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const url = `${proto}://${host}/api/admin/code-intel/shadow-stats`;
  try {
    const cookie = h.get("cookie") ?? "";
    const res = await fetch(url, {
      headers: { cookie },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { ok: false, error: `shadow-stats endpoint returned ${res.status}` };
    }
    const data = (await res.json()) as ShadowStats;
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function CodeIntelShadowWidget() {
  const r = await getShadow();
  return (
    <Card title="Code Intelligence v1 vs v2 Shadow" subtitle="last 24h, sampled">
      {!r.ok ? (
        <ErrorState message={r.error} />
      ) : r.data.totalCalls === 0 ? (
        <EmptyState message="No shadow samples yet. Set CODE_INTEL_V2=shadow to start collecting comparison data." />
      ) : (
        <ShadowBody data={r.data} />
      )}
    </Card>
  );
}

function ShadowBody({ data }: { data: ShadowStats }) {
  const { totalCalls, v1, v2, divergence, topDiverging } = data;

  // Color hint on divergence: <10% = neutral, <30% = amber, >=30% = red.
  const divClass =
    divergence.pct >= 30
      ? "text-rose-500"
      : divergence.pct >= 10
        ? "text-amber-400"
        : "";

  // Color hint on v2 latency vs v1.
  const v2P95Class =
    v2.p95Ms <= v1.p95Ms
      ? "text-emerald-400"
      : v2.p95Ms <= v1.p95Ms * 1.5
        ? ""
        : "text-amber-400";

  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-baseline justify-between">
        <span className="text-fg-base/60">samples (24h)</span>
        <span className="font-mono text-base text-fg-strong">
          {totalCalls.toLocaleString()}
        </span>
      </div>

      <div className="border-t border-line pt-3">
        <div className="text-[11px] uppercase tracking-wide text-fg-base/40">
          latency p50 / p95 (ms)
        </div>
        <div className="mt-1 grid grid-cols-3 gap-2 font-mono">
          <span></span>
          <span className="text-fg-base/60">v1</span>
          <span className="text-fg-base/60">v2</span>
          <span className="text-fg-base/60">p50</span>
          <span>{v1.p50Ms}</span>
          <span>{v2.p50Ms}</span>
          <span className="text-fg-base/60">p95</span>
          <span>{v1.p95Ms}</span>
          <span className={v2P95Class}>{v2.p95Ms}</span>
        </div>
      </div>

      <div className="border-t border-line pt-3">
        <div className="flex justify-between font-mono">
          <span className="text-fg-base/60">divergent calls</span>
          <span className={divClass}>
            {divergence.pct}% ({divergence.count.toLocaleString()})
          </span>
        </div>
        <div className="mt-1 flex justify-between font-mono text-fg-base/40">
          <span>v2 empty result</span>
          <span>{v2.emptyResultCount.toLocaleString()}</span>
        </div>
        {(v1.errors > 0 || v2.errors > 0) && (
          <div className="mt-1 flex justify-between font-mono text-amber-400">
            <span>errors v1 / v2</span>
            <span>
              {v1.errors} / {v2.errors}
            </span>
          </div>
        )}
      </div>

      {topDiverging.length > 0 && (
        <div className="border-t border-line pt-3">
          <div className="text-[11px] uppercase tracking-wide text-fg-base/40">
            top diverging (last 5)
          </div>
          <div className="mt-1 space-y-2 font-mono">
            {topDiverging.map((d) => (
              <div key={`${d.createdAt}-${d.query}`} className="space-y-0.5">
                <div className="truncate text-fg-base/70">&quot;{d.query}&quot;</div>
                <div className="flex flex-col gap-0.5 text-[11px] text-fg-base/40">
                  <span className="truncate">
                    v1: {d.v1Top.slice(0, 3).join(", ") || "<empty>"}
                  </span>
                  <span className="truncate">
                    v2: {d.v2Top.slice(0, 3).join(", ") || "<empty>"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
