function Sk({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`animate-pulse rounded bg-black/[0.08] dark:bg-white/[0.05] ${className ?? ""}`} style={style} />;
}

export default function AnalyticsLoading() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-1.5">
        <Sk className="h-6 w-24" />
        <Sk className="h-3 w-64" />
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-xl border border-line bg-surface px-5 py-4">
            <Sk className="h-3 w-16" />
            <Sk className="h-7 w-12" />
            <Sk className="h-2.5 w-20" />
          </div>
        ))}
      </div>

      {/* Bar chart */}
      <div className="rounded-xl border border-line bg-surface p-5">
        <div className="mb-4 flex items-center justify-between">
          <Sk className="h-4 w-24" />
          <div className="flex items-center gap-3">
            <Sk className="h-3 w-14" />
            <Sk className="h-3 w-14" />
            <Sk className="h-3 w-14" />
          </div>
        </div>
        <div className="flex items-end gap-1.5" style={{ height: "200px" }}>
          {[60, 90, 40, 110, 75, 30, 95, 50, 120, 45, 80, 55, 100, 70].map((h, i) => (
            <div key={i} className="flex flex-1 flex-col items-center gap-1.5">
              <div className="flex w-full flex-col justify-end" style={{ height: "160px" }}>
                <Sk
                  className="w-full rounded-t"
                  style={{ height: `${h}px` }}
                />
              </div>
              <Sk className="h-2.5 w-8" />
            </div>
          ))}
        </div>
      </div>

      {/* Two-column breakdown */}
      <div className="grid gap-3 md:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-line bg-surface p-5">
            <Sk className="mb-4 h-4 w-20" />
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, j) => (
                <div key={j} className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Sk className="h-3 w-16" />
                    <Sk className="h-3 w-8" />
                  </div>
                  <Sk className="h-2 w-full rounded-full" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
