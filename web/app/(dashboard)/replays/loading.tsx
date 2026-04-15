function Sk({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-black/[0.08] dark:bg-white/[0.05] ${className ?? ""}`} />;
}

export default function ReplaysLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1.5">
          <Sk className="h-6 w-24" />
          <Sk className="h-3 w-64" />
        </div>
      </div>

      {/* Filters bar */}
      <div className="flex flex-wrap items-center gap-2">
        <Sk className="h-8 w-48 rounded-md" />
        <Sk className="h-8 w-32 rounded-md" />
        <Sk className="h-8 w-28 rounded-md" />
        <Sk className="h-8 w-24 rounded-md" />
      </div>

      {/* Cards */}
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-line bg-surface px-4 py-3.5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <Sk className="h-3 w-24" />
                  <Sk className="h-4 w-28 rounded-md" />
                  {i % 2 === 0 && <Sk className="h-4 w-20 rounded-md" />}
                  {i % 3 === 0 && <Sk className="h-4 w-16 rounded-md" />}
                </div>
                <Sk className={`h-3.5 ${i % 3 === 0 ? "w-3/4" : i % 3 === 1 ? "w-2/3" : "w-1/2"}`} />
                <div className="flex items-center gap-3">
                  <Sk className="h-2.5 w-16" />
                  <Sk className="h-2.5 w-12" />
                  <Sk className="h-2.5 w-10" />
                  <Sk className="h-2.5 w-14" />
                </div>
              </div>
              <Sk className="h-3 w-16 shrink-0" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
