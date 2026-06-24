/**
 * SLO Status widget — /admin/ai (Fase 12 Part A).
 *
 * Left column: current 15-min rolling SLOs per tier (p95 + success rate)
 * with a traffic-light indicator against the configured thresholds.
 * Right column: currently-open breaches from `slo_events`, highlighting
 * any with consecutive_breach_count >= PAGING_THRESHOLD.
 *
 * Server component — shares the same measurement function the cron uses
 * so the dashboard and the paging channel never disagree.
 */

import {
  measureTiers,
  getActiveBreaches,
  SLO_DEFINITIONS,
  ALL_TIERS,
  WINDOW_MINUTES,
  PAGING_THRESHOLD,
  type Tier,
  type TierMeasurement,
} from "@/lib/ai/slo-monitor";
import type { SLOEvent } from "@/lib/db";

function formatP95(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  return `${(ms / 1_000).toFixed(1)}s`;
}

function formatSuccessRate(rate: number | null): string {
  if (rate == null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

function tierLabel(tier: Tier): string {
  switch (tier) {
    case "0": return "Tier 0 — Pattern";
    case "1": return "Tier 1 — Single-shot";
    case "2": return "Tier 2 — Agentic";
    case "3": return "Tier 3 — Multi-agent";
  }
}

function cellClass(ok: boolean, hasSignal: boolean): string {
  if (!hasSignal) return "text-zinc-500";
  return ok ? "text-emerald-400" : "text-red-400";
}

function formatBreachObserved(event: SLOEvent): string {
  if (event.metric === "p95_latency_ms") return formatP95(event.observedValue);
  if (event.metric === "success_rate")   return formatSuccessRate(event.observedValue);
  return String(event.observedValue);
}

function formatBreachThreshold(event: SLOEvent): string {
  if (event.metric === "p95_latency_ms") return `≤ ${formatP95(event.thresholdValue)}`;
  if (event.metric === "success_rate")   return `≥ ${formatSuccessRate(event.thresholdValue)}`;
  return String(event.thresholdValue);
}

function metricLabel(metric: string): string {
  return metric === "p95_latency_ms" ? "p95 latency" : "success rate";
}

export default async function SLOStatusWidget() {
  const [measurements, activeBreaches] = await Promise.all([
    measureTiers(),
    getActiveBreaches(),
  ]);

  const byTier = new Map<Tier, TierMeasurement>();
  for (const m of measurements) byTier.set(m.tier, m);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 md:col-span-2">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-mono text-violet-400 uppercase tracking-wider">
          SLO Status (Fase 12)
        </h2>
        <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">
          rolling {WINDOW_MINUTES}m · {activeBreaches.length} open
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <p className="text-xs text-zinc-400 mb-3">Live SLOs</p>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-zinc-500 border-b border-zinc-800">
                <th className="pb-2">Tier</th>
                <th className="pb-2 text-right">Samples</th>
                <th className="pb-2 text-right">p95</th>
                <th className="pb-2 text-right">Success</th>
              </tr>
            </thead>
            <tbody>
              {ALL_TIERS.map((tier) => {
                const m = byTier.get(tier);
                const slo = SLO_DEFINITIONS[tier];
                const samples = m?.sampleCount ?? 0;
                const p95 = m?.p95LatencyMs ?? null;
                const rate = m?.successRate ?? null;
                const p95Ok = p95 == null ? false : p95 <= slo.p95LatencyMs;
                const rateOk = rate == null ? false : rate >= slo.successRate;
                return (
                  <tr key={tier} className="border-b border-zinc-900">
                    <td className="py-2 font-mono text-xs text-zinc-200">{tierLabel(tier)}</td>
                    <td className="py-2 text-right text-zinc-400">{samples}</td>
                    <td className={`py-2 text-right font-mono text-xs ${cellClass(p95Ok, p95 != null)}`}>
                      {formatP95(p95)}
                      <span className="text-zinc-600 ml-1">/ {formatP95(slo.p95LatencyMs)}</span>
                    </td>
                    <td className={`py-2 text-right font-mono text-xs ${cellClass(rateOk, rate != null)}`}>
                      {formatSuccessRate(rate)}
                      <span className="text-zinc-600 ml-1">/ {formatSuccessRate(slo.successRate)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-xs text-zinc-600 mt-3">
            Sparse tiers (fewer than the minSamples threshold) show — for their metric; breaches are not
            opened or closed on sparse windows.
          </p>
        </div>

        <div>
          <p className="text-xs text-zinc-400 mb-3">Open breaches</p>
          {activeBreaches.length === 0 ? (
            <p className="text-sm text-emerald-400">All SLOs green.</p>
          ) : (
            <ul className="space-y-2">
              {activeBreaches.map((ev) => {
                const paging = ev.consecutiveBreachCount >= PAGING_THRESHOLD;
                return (
                  <li
                    key={ev.id}
                    className={`rounded border p-3 text-xs ${
                      paging
                        ? "border-red-500/30 bg-red-500/5"
                        : "border-amber-500/20 bg-amber-500/5"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono text-zinc-200">
                        {tierLabel(ev.tier as Tier)} · {metricLabel(ev.metric)}
                      </span>
                      {paging && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-red-500/15 text-red-300 border border-red-500/30">
                          PAGE
                        </span>
                      )}
                    </div>
                    <p className="font-mono text-zinc-400">
                      observed {formatBreachObserved(ev)}
                      <span className="text-zinc-600"> · threshold {formatBreachThreshold(ev)}</span>
                    </p>
                    <p className="text-zinc-600 mt-1">
                      firing for {ev.consecutiveBreachCount} consecutive 5-min window
                      {ev.consecutiveBreachCount === 1 ? "" : "s"}
                      <span className="text-zinc-700"> · {ev.sampleCount} samples</span>
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-xs text-zinc-600 mt-3">
            PAGE highlights when `consecutive_breach_count ≥ {PAGING_THRESHOLD}` (matches the arch spec&apos;s 3 consecutive
            window rule).
          </p>
        </div>
      </div>
    </div>
  );
}
