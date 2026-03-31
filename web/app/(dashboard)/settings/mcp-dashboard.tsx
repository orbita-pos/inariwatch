"use client";

type McpStats = {
  totalCalls: number;
  totalErrors: number;
  avgLatencyMs: number;
  p99LatencyMs: number;
  topTools: { tool: string; count: number }[];
  callsByDay: { date: string; count: number }[];
};

export function McpDashboard({ stats }: { stats: McpStats }) {
  const errorRate = stats.totalCalls > 0
    ? ((stats.totalErrors / stats.totalCalls) * 100).toFixed(1)
    : "0";

  return (
    <div className="py-3 space-y-4">
      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total calls" value={stats.totalCalls.toLocaleString()} />
        <StatCard label="Error rate" value={`${errorRate}%`} warn={Number(errorRate) > 5} />
        <StatCard label="Avg latency" value={`${stats.avgLatencyMs}ms`} />
        <StatCard label="p99 latency" value={`${stats.p99LatencyMs}ms`} warn={stats.p99LatencyMs > 5000} />
      </div>

      {/* Top tools */}
      {stats.topTools.length > 0 && (
        <div>
          <p className="text-xs font-medium text-zinc-500 mb-2">Top tools (30 days)</p>
          <div className="space-y-1.5">
            {stats.topTools.map((t) => {
              const pct = stats.totalCalls > 0 ? (t.count / stats.totalCalls) * 100 : 0;
              return (
                <div key={t.tool} className="flex items-center gap-2">
                  <span className="w-40 truncate text-xs font-mono text-fg-base">{t.tool.replace("mcp.", "")}</span>
                  <div className="flex-1 h-2 rounded-full bg-black/[0.06] dark:bg-white/[0.06]">
                    <div
                      className="h-full rounded-full bg-inari-accent"
                      style={{ width: `${Math.max(pct, 2)}%` }}
                    />
                  </div>
                  <span className="w-12 text-right text-[11px] text-zinc-500">{t.count}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Calls by day */}
      {stats.callsByDay.length > 0 && (
        <div>
          <p className="text-xs font-medium text-zinc-500 mb-2">Calls / day (last 7 days)</p>
          <div className="flex items-end gap-1 h-16">
            {stats.callsByDay.map((d) => {
              const max = Math.max(...stats.callsByDay.map((x) => x.count), 1);
              const pct = (d.count / max) * 100;
              return (
                <div key={d.date} className="flex-1 flex flex-col items-center gap-0.5">
                  <div
                    className="w-full rounded-sm bg-inari-accent/70"
                    style={{ height: `${Math.max(pct, 4)}%` }}
                    title={`${d.date}: ${d.count} calls`}
                  />
                  <span className="text-[9px] text-zinc-600">{d.date.slice(5)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {stats.totalCalls === 0 && (
        <p className="text-sm text-zinc-500 text-center py-2">
          No MCP calls yet. Connect an AI tool to get started.
        </p>
      )}
    </div>
  );
}

function StatCard({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${warn ? "border-amber-900/40 bg-amber-950/20" : "border-line bg-surface-inner"}`}>
      <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</p>
      <p className={`text-lg font-semibold ${warn ? "text-amber-400" : "text-fg-strong"}`}>{value}</p>
    </div>
  );
}
