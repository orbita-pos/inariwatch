import { db } from "@/lib/db";
import { eapReceipts } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import { Card, EmptyState, ErrorState } from "./card";

// Cap server-component freshness to 30s — matches the rest of /admin/ops.
export const revalidate = 30;

type Counts = {
  total: number;
  verifiedTrue: number;
  verifiedFalse: number;
  verifiedNull: number;
  signed: number;
  unsigned: number;
  oldestPendingAgeHours: number | null;
};

async function getCounts(): Promise<{ ok: true; data: Counts } | { ok: false; error: string }> {
  try {
    // One round-trip — split out via FILTER aggregates. Cheaper than 5 selects.
    // `verified` is BOOLEAN NULLABLE: true = local verify pass, false = local
    // verify fail (recorded), null = not yet verified locally.
    const rows = await db
      .select({
        total: sql<string>`count(*)`,
        verifiedTrue: sql<string>`count(*) filter (where ${eapReceipts.verified} = true)`,
        verifiedFalse: sql<string>`count(*) filter (where ${eapReceipts.verified} = false)`,
        verifiedNull: sql<string>`count(*) filter (where ${eapReceipts.verified} is null)`,
        signed: sql<string>`count(*) filter (where ${eapReceipts.signed} = true)`,
        unsigned: sql<string>`count(*) filter (where ${eapReceipts.signed} = false)`,
        oldestPendingMs: sql<string | null>`extract(epoch from (now() - min(${eapReceipts.createdAt}) filter (where ${eapReceipts.verified} is null and ${eapReceipts.signature} is not null))) * 1000`,
      })
      .from(eapReceipts);

    const r = rows[0];
    if (!r) {
      return {
        ok: true,
        data: {
          total: 0,
          verifiedTrue: 0,
          verifiedFalse: 0,
          verifiedNull: 0,
          signed: 0,
          unsigned: 0,
          oldestPendingAgeHours: null,
        },
      };
    }

    const oldestMs = r.oldestPendingMs ? Number(r.oldestPendingMs) : null;
    return {
      ok: true,
      data: {
        total: Number(r.total),
        verifiedTrue: Number(r.verifiedTrue),
        verifiedFalse: Number(r.verifiedFalse),
        verifiedNull: Number(r.verifiedNull),
        signed: Number(r.signed),
        unsigned: Number(r.unsigned),
        oldestPendingAgeHours:
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

export async function EapVerifyWidget() {
  const flagOn = process.env.EAP_LOCAL_VERIFY_ENABLED === "true";
  const r = await getCounts();

  return (
    <Card
      title="EAP local verify"
      subtitle={
        flagOn
          ? "Gate 6 input — Ed25519 verified locally"
          : "feature flag OFF — Gate 6 still trusts EAP server"
      }
    >
      {!r.ok ? (
        <ErrorState message={r.error} />
      ) : r.data.total === 0 ? (
        <EmptyState message="No eap_receipts rows yet — Gate 6 hasn't fired in production." />
      ) : (
        <div className="space-y-3 text-xs">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <div className="text-fg-base/60">Verified ✓</div>
              <div className="font-mono text-emerald-500 text-base">
                {r.data.verifiedTrue.toLocaleString()}
              </div>
              <div className="text-fg-base/50">
                {pct(r.data.verifiedTrue, r.data.signed)} of signed
              </div>
            </div>
            <div>
              <div className="text-fg-base/60">Failed ✗</div>
              <div
                className={`font-mono text-base ${r.data.verifiedFalse > 0 ? "text-red-500" : "text-fg-base/70"}`}
              >
                {r.data.verifiedFalse.toLocaleString()}
              </div>
              <div className="text-fg-base/50">
                {r.data.verifiedFalse > 0 ? "investigate" : "clean"}
              </div>
            </div>
            <div>
              <div className="text-fg-base/60">Pending</div>
              <div
                className={`font-mono text-base ${r.data.verifiedNull > 0 ? "text-amber-500" : "text-fg-base/70"}`}
              >
                {r.data.verifiedNull.toLocaleString()}
              </div>
              <div className="text-fg-base/50">
                {r.data.oldestPendingAgeHours !== null
                  ? `oldest ${r.data.oldestPendingAgeHours}h`
                  : "—"}
              </div>
            </div>
          </div>
          <div className="border-t border-line pt-3 text-fg-base/60">
            <div className="flex justify-between font-mono">
              <span>signed receipts</span>
              <span>
                {r.data.signed.toLocaleString()} /{" "}
                {r.data.total.toLocaleString()} total
              </span>
            </div>
            {r.data.unsigned > 0 ? (
              <div className="mt-1 flex justify-between font-mono text-fg-base/50">
                <span>unsigned (server had no key)</span>
                <span>{r.data.unsigned.toLocaleString()}</span>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </Card>
  );
}
