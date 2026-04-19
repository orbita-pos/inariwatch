import "server-only";
import { db, alerts } from "@/lib/db";
import { and, gte, inArray, sql } from "drizzle-orm";
import { Card, ErrorState } from "./card";

async function readErrorStats() {
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [lastHour, lastDay] = await Promise.all([
      db
        .select({
          severity: alerts.severity,
          count: sql<number>`count(*)::int`,
        })
        .from(alerts)
        .where(
          and(
            gte(alerts.createdAt, oneHourAgo),
            inArray(alerts.severity, ["critical", "warning"] as const),
          ),
        )
        .groupBy(alerts.severity),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(alerts)
        .where(
          and(
            gte(alerts.createdAt, oneDayAgo),
            inArray(alerts.severity, ["critical", "warning"] as const),
          ),
        ),
    ]);
    const critical = lastHour.find((r) => r.severity === "critical")?.count ?? 0;
    const warning = lastHour.find((r) => r.severity === "warning")?.count ?? 0;
    return {
      ok: true as const,
      lastHour: { critical, warning, total: critical + warning },
      lastDay: lastDay[0]?.count ?? 0,
    };
  } catch (e) {
    return {
      ok: false as const,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function ErrorsWidget() {
  const r = await readErrorStats();
  return (
    <Card
      title="Own-product alerts"
      subtitle={r.ok ? `last 1h · critical+warning` : undefined}
    >
      {!r.ok ? (
        <ErrorState message={r.error} />
      ) : (
        <div className="space-y-3">
          <div className="flex items-baseline gap-3">
            <span
              className={`text-3xl font-semibold tabular-nums ${
                r.lastHour.total === 0
                  ? "text-fg-base/40"
                  : r.lastHour.critical > 0
                    ? "text-red-500"
                    : "text-amber-500"
              }`}
            >
              {r.lastHour.total}
            </span>
            <span className="text-xs text-fg-base/60">in last hour</span>
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <div className="text-fg-base/60">Critical</div>
              <div className="mt-0.5 font-mono text-red-500">{r.lastHour.critical}</div>
            </div>
            <div>
              <div className="text-fg-base/60">Warning</div>
              <div className="mt-0.5 font-mono text-amber-500">{r.lastHour.warning}</div>
            </div>
            <div className="col-span-2">
              <div className="text-fg-base/60">Last 24 hours</div>
              <div className="mt-0.5 font-mono">{r.lastDay}</div>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
