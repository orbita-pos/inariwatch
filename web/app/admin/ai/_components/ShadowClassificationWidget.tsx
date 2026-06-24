/**
 * Shadow Classification widget — /admin/ai.
 *
 * Fase 6 MVP, 3 metrics only (per spec review). Richer UI ships post-soak
 * (14d) once the metrics stabilize and we learn what operators actually
 * look at. Designing against 0 samples is a waste.
 *
 * Server component — pulls from `lib/ai/pattern-memory-telemetry.ts`.
 * Mirrors the Tailwind / zinc palette used by the rest of /admin/ai.
 */

import Link from "next/link";
import {
  getTierDistribution,
  getClassifierAccuracy,
  getLookupHitRate,
  type TierDistribution,
} from "@/lib/ai/pattern-memory-telemetry";

const TIER_ORDER: Array<{ key: TierDistribution[number]["tier"]; label: string; color: string }> = [
  { key: "0",      label: "Tier 0",  color: "text-green-400" },
  { key: "1",      label: "Tier 1",  color: "text-emerald-400" },
  { key: "2",      label: "Tier 2",  color: "text-sky-400" },
  { key: "3",      label: "Tier 3",  color: "text-violet-400" },
  { key: "legacy", label: "Legacy",  color: "text-zinc-400" },
];

export default async function ShadowClassificationWidget() {
  const [distribution, accuracy, lookup] = await Promise.all([
    getTierDistribution(),
    getClassifierAccuracy(),
    getLookupHitRate(),
  ]);

  const total = distribution.reduce((s, d) => s + d.count, 0);
  const rows = TIER_ORDER.map((t) => {
    const found = distribution.find((d) => d.tier === t.key);
    const count = found?.count ?? 0;
    const pct = total === 0 ? 0 : Math.round((count / total) * 100);
    return { ...t, count, pct };
  });

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 md:col-span-2">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-mono text-violet-400 uppercase tracking-wider">
          Shadow Classification (Fase 6)
        </h2>
        <div className="flex items-center gap-3">
          <Link
            href="/admin/ai/labels"
            className="text-[10px] font-mono text-violet-400 uppercase tracking-wider hover:text-violet-300"
          >
            Label sessions →
          </Link>
          <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">
            7d · {total} classified
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div>
          <p className="text-xs text-zinc-400 mb-2">Tier distribution</p>
          <ul className="space-y-1">
            {rows.map((r) => (
              <li key={r.key} className="flex items-center justify-between text-sm">
                <span className={`font-mono ${r.color}`}>{r.label}</span>
                <span className="text-zinc-300">
                  {r.count}
                  <span className="text-xs text-zinc-500 ml-2">{r.pct}%</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <p className="text-xs text-zinc-400 mb-2">
            Classifier accuracy
            {accuracy.isApproximation && (
              <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-mono bg-amber-500/10 text-amber-400 border border-amber-500/20">
                approx
              </span>
            )}
          </p>
          <p className="text-3xl font-bold text-white">
            {accuracy.accuracyPct}
            <span className="text-base text-zinc-500 ml-1">%</span>
          </p>
          <p className="text-xs text-zinc-500 mt-2">
            {accuracy.accurateCount} / {accuracy.labeledCount} shadow sessions completed + post-merge passed.
          </p>
          <p className="text-xs text-zinc-600 mt-1">
            True accuracy (vs 50 human labels) ships post-soak.
          </p>
        </div>

        <div>
          <p className="text-xs text-zinc-400 mb-2">Pattern lookup hit rate</p>
          <p className="text-3xl font-bold text-white">
            {lookup.hitRatePct}
            <span className="text-base text-zinc-500 ml-1">%</span>
          </p>
          <p className="text-xs text-zinc-500 mt-2">
            {lookup.hits} / {lookup.totalLookups} lookups returned ≥1 match at score ≥ 0.88.
          </p>
          <p className="text-xs text-zinc-600 mt-1">
            Low hit rate is expected until pattern_memory accumulates.
          </p>
        </div>
      </div>
    </div>
  );
}
