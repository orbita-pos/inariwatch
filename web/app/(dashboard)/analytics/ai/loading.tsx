function Sk({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`animate-pulse rounded bg-black/[0.08] dark:bg-white/[0.05] ${className ?? ""}`} style={style} />;
}

export default function AIAnalyticsLoading() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-1.5">
        <Sk className="h-6 w-36" />
        <Sk className="h-3 w-72" />
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-xl border border-line bg-surface px-5 py-4">
            <Sk className="h-3 w-20" />
            <Sk className="h-7 w-14" />
            <Sk className="h-2.5 w-24" />
          </div>
        ))}
      </div>

      {/* MTTR comparison */}
      <div className="grid gap-3 md:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-line bg-surface px-5 py-4">
            <Sk className="mb-3 h-3 w-24" />
            <Sk className="mb-1 h-8 w-20" />
            <Sk className="h-2.5 w-32" />
          </div>
        ))}
      </div>

      {/* Bar chart */}
      <div className="rounded-xl border border-line bg-surface p-5">
        <Sk className="mb-4 h-4 w-48" />
        <div className="flex items-end gap-1.5" style={{ height: "180px" }}>
          {[60, 90, 40, 110, 75, 30, 95, 50, 120, 45, 80, 55, 100, 70].map((h, i) => (
            <div key={i} className="flex flex-1 flex-col items-center gap-1.5">
              <div className="flex w-full flex-col justify-end" style={{ height: "140px" }}>
                <Sk className="w-full rounded-t" style={{ height: `${h}px` }} />
              </div>
              <Sk className="h-2.5 w-6" />
            </div>
          ))}
        </div>
      </div>

      {/* Safety gate pass rates */}
      <div className="rounded-xl border border-line bg-surface p-5">
        <Sk className="mb-4 h-4 w-36" />
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Sk className="h-3 w-28" />
                <Sk className="h-3 w-10" />
              </div>
              <Sk className="h-2 w-full rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
