// /admin/ops AI router receipts widget — v0.3 S2.5.
//
// Aggregates the last 24h of `ai_router_receipts` (migration 0076) into:
//   - total dispatch count
//   - substrate breakdown (cloud / user-sidecar / capture-embedded / cli-linked)
//   - top 5 tasks by count
//   - p50 / p95 latency per substrate
//   - fallback count (primary failed → fallback target ran)
//
// Data source: GET /api/admin/router/receipts/summary (admin-only, server
// component fetches with cache: "no-store" so the widget reflects live state).

import { Card, EmptyState, ErrorState } from "./card";
import { headers } from "next/headers";

export const revalidate = 30;

interface SubstrateBucket {
  substrate: string;
  count: number;
  p50DurationMs: number;
  p95DurationMs: number;
}

interface TaskBucket {
  task: string;
  count: number;
}

interface ReceiptSummary {
  windowHours: number;
  total: number;
  bySubstrate: SubstrateBucket[];
  topTasks: TaskBucket[];
  fallbackCount: number;
}

async function getSummary(): Promise<
  { ok: true; data: ReceiptSummary } | { ok: false; error: string }
> {
  // Server-component → server route on the same host. Read from the request
  // headers so we resolve to the correct origin in dev / preview / prod.
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto =
    h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const url = `${proto}://${host}/api/admin/router/receipts/summary`;
  try {
    const cookie = h.get("cookie") ?? "";
    const res = await fetch(url, {
      headers: { cookie },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return { ok: false, error: `summary endpoint returned ${res.status}` };
    }
    const data = (await res.json()) as ReceiptSummary;
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function RouterReceiptsWidget() {
  const r = await getSummary();
  return (
    <Card
      title="AI router receipts"
      subtitle="last 24h dispatches"
    >
      {!r.ok ? (
        <ErrorState message={r.error} />
      ) : r.data.total === 0 ? (
        <EmptyState message="No receipts yet. dispatch() emits one per call once traffic flows." />
      ) : (
        <SummaryBody data={r.data} />
      )}
    </Card>
  );
}

function SummaryBody({ data }: { data: ReceiptSummary }) {
  const totalDispatches = data.total.toLocaleString();
  const fallbackPct =
    data.total > 0 ? ((data.fallbackCount / data.total) * 100).toFixed(1) : "0.0";

  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-baseline justify-between">
        <span className="text-fg-base/60">total dispatches</span>
        <span className="font-mono text-base text-fg-strong">{totalDispatches}</span>
      </div>

      <div className="border-t border-line pt-3">
        <div className="text-[11px] uppercase tracking-wide text-fg-base/40">
          by substrate
        </div>
        <div className="mt-1 space-y-1 font-mono">
          {data.bySubstrate.length === 0 ? (
            <div className="text-fg-base/40">—</div>
          ) : (
            data.bySubstrate.map((b) => (
              <div key={b.substrate} className="flex justify-between gap-2">
                <span className="text-fg-base/60">{b.substrate}</span>
                <span className="text-fg-base/40">
                  p50 {b.p50DurationMs}ms · p95 {b.p95DurationMs}ms
                </span>
                <span className="min-w-[3ch] text-right">{b.count.toLocaleString()}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="border-t border-line pt-3">
        <div className="text-[11px] uppercase tracking-wide text-fg-base/40">
          top tasks
        </div>
        <div className="mt-1 space-y-1 font-mono">
          {data.topTasks.length === 0 ? (
            <div className="text-fg-base/40">—</div>
          ) : (
            data.topTasks.map((t) => (
              <div key={t.task} className="flex justify-between">
                <span className="text-fg-base/60 truncate">{t.task}</span>
                <span>{t.count.toLocaleString()}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="border-t border-line pt-3 flex justify-between font-mono text-fg-base/60">
        <span>fallbacks (primary → fallback)</span>
        <span className={data.fallbackCount > data.total * 0.05 ? "text-amber-500" : ""}>
          {data.fallbackCount.toLocaleString()} ({fallbackPct}%)
        </span>
      </div>
    </div>
  );
}
