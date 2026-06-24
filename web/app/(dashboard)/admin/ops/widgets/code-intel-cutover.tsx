// /admin/ops Code Intelligence v2 cutover decision widget — Phase 3.3.
// Reads from /api/admin/code-intel/cutover-status and renders the
// GO/WAIT/ABORT verdict + the metrics that drove it.

import { Card, EmptyState, ErrorState } from "./card";
import { headers } from "next/headers";

export const revalidate = 60;

interface CutoverStatusResponse {
  windowHours: number;
  thresholds: {
    minSamples: number;
    turnReductionPct: number;
    successParityPct: number;
    divergenceMaxPct: number;
  };
  metrics: {
    ab: {
      total: number;
      v1Count: number;
      v2Count: number;
      v1AvgTurns: number;
      v2AvgTurns: number;
      v1SuccessPct: number;
      v2SuccessPct: number;
      turnReductionPct: number;
      successDeltaPct: number;
    };
    shadow: {
      total: number;
      divergentCount: number;
      divergencePct: number;
      timeoutCount: number;
      timeoutPct: number;
    };
  };
  decision: {
    recommendation: "GO" | "WAIT" | "ABORT";
    reasons: string[];
    gates: Array<{
      id: "samples" | "turn_reduction" | "success_parity" | "divergence";
      passed: boolean;
      detail: string;
      triggers: "GO" | "WAIT" | "ABORT";
    }>;
  };
}

async function getCutover(): Promise<
  { ok: true; data: CutoverStatusResponse } | { ok: false; error: string }
> {
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const url = `${proto}://${host}/api/admin/code-intel/cutover-status`;
  try {
    const cookie = h.get("cookie") ?? "";
    const res = await fetch(url, {
      headers: { cookie },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, error: `cutover-status endpoint returned ${res.status}` };
    const data = (await res.json()) as CutoverStatusResponse;
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function CodeIntelCutoverWidget() {
  const r = await getCutover();
  return (
    <Card title="Code Intelligence Cutover Decision" subtitle="v1 -> v2 default flip">
      {!r.ok ? (
        <ErrorState message={r.error} />
      ) : r.data.metrics.ab.total === 0 && r.data.metrics.shadow.total === 0 ? (
        <EmptyState message="No A/B or shadow samples in the window. Set CODE_INTEL_V2=shadow + CONTAINER_AGENT_AB_PCT > 0 to start collecting data." />
      ) : (
        <CutoverBody data={r.data} />
      )}
    </Card>
  );
}

function badgeStyle(rec: "GO" | "WAIT" | "ABORT"): string {
  if (rec === "GO") return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  if (rec === "WAIT") return "bg-amber-500/15 text-amber-400 border-amber-500/30";
  return "bg-rose-500/15 text-rose-400 border-rose-500/30";
}

function gateColor(passed: boolean): string {
  return passed ? "text-emerald-400" : "text-rose-400";
}

function CutoverBody({ data }: { data: CutoverStatusResponse }) {
  const { metrics, decision, thresholds, windowHours } = data;
  const ab = metrics.ab;
  const shadow = metrics.shadow;
  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="text-fg-base/60">recommendation</span>
        <span
          className={`rounded border px-2 py-0.5 font-mono text-xs uppercase ${badgeStyle(decision.recommendation)}`}
        >
          {decision.recommendation}
        </span>
      </div>

      <div className="border-t border-line pt-3">
        <div className="text-[11px] uppercase tracking-wide text-fg-base/40">window</div>
        <div className="mt-1 font-mono text-fg-base/60">
          last {windowHours}h, need at least {thresholds.minSamples} A/B samples
        </div>
      </div>

      <div className="border-t border-line pt-3">
        <div className="text-[11px] uppercase tracking-wide text-fg-base/40">A/B telemetry</div>
        <div className="mt-1 grid grid-cols-3 gap-2 font-mono">
          <span></span>
          <span className="text-fg-base/60">v1</span>
          <span className="text-fg-base/60">v2</span>
          <span className="text-fg-base/60">samples</span>
          <span>{ab.v1Count.toLocaleString()}</span>
          <span>{ab.v2Count.toLocaleString()}</span>
          <span className="text-fg-base/60">avg turns</span>
          <span>{Number.isFinite(ab.v1AvgTurns) ? ab.v1AvgTurns : "-"}</span>
          <span>{Number.isFinite(ab.v2AvgTurns) ? ab.v2AvgTurns : "-"}</span>
          <span className="text-fg-base/60">success %</span>
          <span>{ab.v1SuccessPct}</span>
          <span>{ab.v2SuccessPct}</span>
        </div>
        <div className="mt-2 flex justify-between font-mono">
          <span className="text-fg-base/60">turn reduction</span>
          <span>
            {ab.turnReductionPct.toFixed(1)}% (need at least {thresholds.turnReductionPct}%)
          </span>
        </div>
        <div className="mt-1 flex justify-between font-mono">
          <span className="text-fg-base/60">success delta</span>
          <span>
            {ab.successDeltaPct >= 0 ? "+" : ""}
            {ab.successDeltaPct}pp (need at least {thresholds.successParityPct}pp)
          </span>
        </div>
      </div>

      <div className="border-t border-line pt-3">
        <div className="text-[11px] uppercase tracking-wide text-fg-base/40">shadow log</div>
        <div className="mt-1 flex justify-between font-mono">
          <span className="text-fg-base/60">samples</span>
          <span>{shadow.total.toLocaleString()}</span>
        </div>
        <div className="mt-1 flex justify-between font-mono">
          <span className="text-fg-base/60">divergence</span>
          <span>
            {shadow.divergencePct}% (need at most {thresholds.divergenceMaxPct}%)
          </span>
        </div>
        {shadow.timeoutCount > 0 && (
          <div className="mt-1 flex justify-between font-mono">
            <span className="text-fg-base/60">v2 timeouts</span>
            <span>
              {shadow.timeoutPct}% ({shadow.timeoutCount.toLocaleString()})
            </span>
          </div>
        )}
      </div>

      <div className="border-t border-line pt-3">
        <div className="text-[11px] uppercase tracking-wide text-fg-base/40">gates</div>
        <div className="mt-1 space-y-0.5 font-mono">
          {decision.gates.map((g) => (
            <div key={g.id} className="flex gap-2">
              <span className={gateColor(g.passed)}>{g.passed ? "ok" : "fail"}</span>
              <span className="text-fg-base/60">{g.id}:</span>
              <span className="truncate">{g.detail}</span>
            </div>
          ))}
        </div>
      </div>

      {decision.reasons.length > 0 && (
        <div className="border-t border-line pt-3">
          <div className="text-[11px] uppercase tracking-wide text-fg-base/40">
            {decision.recommendation === "GO" ? "next steps" : "what would flip this"}
          </div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 font-mono text-fg-base/60">
            {decision.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
