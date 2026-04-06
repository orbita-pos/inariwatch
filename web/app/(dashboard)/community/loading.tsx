function Sk({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-black/[0.08] dark:bg-white/[0.05] ${className ?? ""}`} />;
}

export default function CommunityLoading() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-1.5">
        <Sk className="h-6 w-40" />
        <Sk className="h-3 w-64" />
      </div>

      {/* Search + filter */}
      <div className="flex items-center gap-3">
        <Sk className="h-9 flex-1 rounded-lg" />
        <Sk className="h-9 w-32 rounded-lg" />
        <Sk className="h-9 w-20 rounded-lg" />
      </div>

      {/* Pattern cards grid */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-line bg-surface p-4 space-y-3">
            <div className="flex items-start justify-between">
              <Sk className="h-4 w-3/4" />
              <Sk className="h-5 w-10 rounded-full" />
            </div>
            <div className="flex items-center gap-2">
              <Sk className="h-5 w-16 rounded-full" />
              <Sk className="h-5 w-12 rounded-full" />
            </div>
            <div className="flex items-center gap-4">
              <Sk className="h-3 w-20" />
              <Sk className="h-3 w-16" />
            </div>
            <Sk className="h-3 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
