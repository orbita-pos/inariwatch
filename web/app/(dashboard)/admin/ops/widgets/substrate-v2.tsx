import { db } from "@/lib/db";
import { substrateReplayComparisons } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import { Card, EmptyState, ErrorState } from "./card";

// Match the rest of /admin/ops — 30s server-component freshness.
export const revalidate = 30;

type Counts = {
  total: number;
  v1Pass: number;
  v1Fail: number;
  v1Null: number;
  v2Pass: number;
  v2Fail: number;
  v2Null: number;
  agreed: number;
  disagreed: number;
  bothNonNull: number;
  // Most recent runner_mode counts for v2, used to surface "stuck on drain".
  v2DrainOnly: number;
  v2Unavailable: number;
  v2Errors: number;
  oldestAgeHours: number | null;
};

async function getCounts(): Promise<{ ok: true; data: Counts } | { ok: false; error: string }> {
  try {
    // Window the widget to the last 7 days — matches the canary success
    // window the user agreed to ("canary corriendo 1 semana sin regression").
    const rows = await db
      .select({
        total: sql<string>`count(*)`,
        v1Pass: sql<string>`count(*) filter (where ${substrateReplayComparisons.v1Passed} = true)`,
        v1Fail: sql<string>`count(*) filter (where ${substrateReplayComparisons.v1Passed} = false)`,
        v1Null: sql<string>`count(*) filter (where ${substrateReplayComparisons.v1Passed} is null)`,
        v2Pass: sql<string>`count(*) filter (where ${substrateReplayComparisons.v2Passed} = true)`,
        v2Fail: sql<string>`count(*) filter (where ${substrateReplayComparisons.v2Passed} = false)`,
        v2Null: sql<string>`count(*) filter (where ${substrateReplayComparisons.v2Passed} is null)`,
        agreed: sql<string>`count(*) filter (where ${substrateReplayComparisons.agreed} = true)`,
        disagreed: sql<string>`count(*) filter (where ${substrateReplayComparisons.agreed} = false)`,
        bothNonNull: sql<string>`count(*) filter (where ${substrateReplayComparisons.agreed} is not null)`,
        v2DrainOnly: sql<string>`count(*) filter (where ${substrateReplayComparisons.v2RunnerMode} in ('drain','no_recording'))`,
        v2Unavailable: sql<string>`count(*) filter (where ${substrateReplayComparisons.v2RunnerMode} in ('unavailable','unconfigured'))`,
        v2Errors: sql<string>`count(*) filter (where ${substrateReplayComparisons.v2RunnerMode} like 'error_%' or ${substrateReplayComparisons.v2RunnerMode} in ('network_error','timeout','error'))`,
        oldestMs: sql<string | null>`extract(epoch from (now() - min(${substrateReplayComparisons.createdAt}))) * 1000`,
      })
      .from(substrateReplayComparisons)
      .where(sql`${substrateReplayComparisons.createdAt} >= now() - interval '7 days'`);

    const r = rows[0];
    if (!r) {
      return {
        ok: true,
        data: {
          total: 0,
          v1Pass: 0,
          v1Fail: 0,
          v1Null: 0,
          v2Pass: 0,
          v2Fail: 0,
          v2Null: 0,
          agreed: 0,
          disagreed: 0,
          bothNonNull: 0,
          v2DrainOnly: 0,
          v2Unavailable: 0,
          v2Errors: 0,
          oldestAgeHours: null,
        },
      };
    }

    const oldestMs = r.oldestMs ? Number(r.oldestMs) : null;
    return {
      ok: true,
      data: {
        total: Number(r.total),
        v1Pass: Number(r.v1Pass),
        v1Fail: Number(r.v1Fail),
        v1Null: Number(r.v1Null),
        v2Pass: Number(r.v2Pass),
        v2Fail: Number(r.v2Fail),
        v2Null: Number(r.v2Null),
        agreed: Number(r.agreed),
        disagreed: Number(r.disagreed),
        bothNonNull: Number(r.bothNonNull),
        v2DrainOnly: Number(r.v2DrainOnly),
        v2Unavailable: Number(r.v2Unavailable),
        v2Errors: Number(r.v2Errors),
        oldestAgeHours:
          oldestMs && Number.isFinite(oldestMs)
            ? Math.round(oldestMs / 3_600_000)
            : null,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function pct(num: number, denom: number): string {
  if (denom === 0) return "—";
  return `${((num / denom) * 100).toFixed(1)}%`;
}

export async function SubstrateV2Widget() {
  const flagOn = process.env.SUBSTRATE_V2_GATE === "true";
  const r = await getCounts();

  return (
    <Card
      title="Substrate replay v1 vs v2"
      subtitle={
        flagOn
          ? "canary on — last 7d"
          : "SUBSTRATE_V2_GATE off — table stays empty"
      }
    >
      {!r.ok ? (
        <ErrorState message={r.error} />
      ) : r.data.total === 0 ? (
        <EmptyState
          message={
            flagOn
              ? "No canary fires yet — waiting on the next remediation that hashes into the 5% bucket."
              : "No comparison rows. Set SUBSTRATE_V2_GATE=true to start the canary."
          }
        />
      ) : (
        <div className="space-y-3 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-fg-base/60">v1 success rate</div>
              <div className="font-mono text-base text-fg-strong">
                {pct(r.data.v1Pass, r.data.v1Pass + r.data.v1Fail)}
              </div>
              <div className="text-fg-base/50">
                {r.data.v1Pass.toLocaleString()} pass / {r.data.v1Fail.toLocaleString()} fail
                {r.data.v1Null > 0 ? ` / ${r.data.v1Null} null` : ""}
              </div>
            </div>
            <div>
              <div className="text-fg-base/60">v2 success rate</div>
              <div className="font-mono text-base text-fg-strong">
                {pct(r.data.v2Pass, r.data.v2Pass + r.data.v2Fail)}
              </div>
              <div className="text-fg-base/50">
                {r.data.v2Pass.toLocaleString()} pass / {r.data.v2Fail.toLocaleString()} fail
                {r.data.v2Null > 0 ? ` / ${r.data.v2Null} null` : ""}
              </div>
            </div>
          </div>

          <div className="border-t border-line pt-3">
            <div className="flex items-baseline justify-between">
              <span className="text-fg-base/60">agreement</span>
              <span className="font-mono text-base text-fg-strong">
                {pct(r.data.agreed, r.data.bothNonNull)}
              </span>
            </div>
            <div className="text-fg-base/50">
              {r.data.bothNonNull.toLocaleString()} comparable rows
              {r.data.disagreed > 0 ? (
                <span className={r.data.disagreed > r.data.agreed ? " text-red-500" : ""}>
                  {" — "}
                  {r.data.disagreed.toLocaleString()} disagree
                </span>
              ) : null}
            </div>
          </div>

          {r.data.v2Null > 0 ? (
            <div className="border-t border-line pt-3 text-fg-base/60">
              <div className="text-[11px] uppercase tracking-wide text-fg-base/40">
                v2 null breakdown
              </div>
              <div className="mt-1 grid grid-cols-3 gap-3 font-mono">
                <div>
                  <div className="text-fg-base/50">drain/no-rec</div>
                  <div>{r.data.v2DrainOnly.toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-fg-base/50">unavailable</div>
                  <div>{r.data.v2Unavailable.toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-fg-base/50">errors</div>
                  <div className={r.data.v2Errors > 0 ? "text-amber-500" : ""}>
                    {r.data.v2Errors.toLocaleString()}
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          <div className="border-t border-line pt-3 flex justify-between font-mono text-fg-base/60">
            <span>total comparisons</span>
            <span>
              {r.data.total.toLocaleString()}
              {r.data.oldestAgeHours !== null
                ? ` · oldest ${r.data.oldestAgeHours}h`
                : ""}
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}
