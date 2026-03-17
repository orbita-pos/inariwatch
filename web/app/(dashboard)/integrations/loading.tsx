function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-zinc-800/60 ${className ?? ""}`} />;
}

export default function IntegrationsLoading() {
  return (
    <div className="space-y-10">
      {/* Header */}
      <div className="space-y-2">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-4 w-72" />
      </div>

      {/* CLI hint */}
      <div className="flex items-start gap-3 rounded-xl border border-inari-border bg-inari-card p-4">
        <Skeleton className="h-4 w-4 mt-0.5 shrink-0" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      </div>

      {/* Integration cards */}
      <div className="space-y-4">
        <Skeleton className="h-3 w-44" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-inari-border bg-inari-card p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <Skeleton className="h-8 w-8 rounded-lg" />
                  <Skeleton className="h-4 w-20" />
                </div>
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-3 w-24 mt-1" />
            </div>
          ))}
        </div>
      </div>

      {/* Per-project tables */}
      <div className="space-y-6">
        <Skeleton className="h-3 w-48" />
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-inari-border overflow-hidden">
            <div className="flex items-center justify-between border-b border-inari-border bg-inari-card px-5 py-3">
              <div className="flex items-center gap-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3 w-20" />
              </div>
              <Skeleton className="h-3 w-20" />
            </div>
            {Array.from({ length: 3 }).map((_, j) => (
              <div key={j} className="flex items-center gap-6 border-b border-inari-border bg-inari-bg px-5 py-3 last:border-0">
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-4 w-14" />
                <Skeleton className="h-3 w-20 hidden md:block" />
                <Skeleton className="h-3 w-6 hidden lg:block" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
