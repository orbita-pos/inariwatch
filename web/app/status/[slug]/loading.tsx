function Sk({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-zinc-800/40 ${className ?? ""}`} />;
}

export default function ProjectStatusLoading() {
  return (
    <div className="min-h-screen bg-page">
      <div className="mx-auto max-w-3xl px-6 py-16">
        {/* Header */}
        <div className="mb-8 space-y-2">
          <Sk className="h-7 w-48" />
          <div className="flex items-center gap-2">
            <Sk className="h-3 w-3 rounded-full" />
            <Sk className="h-3 w-28" />
          </div>
        </div>

        {/* Overall status */}
        <div className="mb-8 rounded-xl border border-line bg-surface p-5 flex items-center gap-4">
          <Sk className="h-10 w-10 rounded-full" />
          <div className="space-y-1.5">
            <Sk className="h-5 w-36" />
            <Sk className="h-3 w-24" />
          </div>
        </div>

        {/* Active incidents */}
        <div className="mb-8">
          <Sk className="mb-4 h-5 w-32" />
          <div className="rounded-xl border border-line bg-surface p-5 space-y-3">
            <div className="flex items-center justify-between">
              <Sk className="h-4 w-48" />
              <Sk className="h-5 w-16 rounded-full" />
            </div>
            <div className="ml-4 space-y-2 border-l-2 border-line pl-4">
              <Sk className="h-3 w-full" />
              <Sk className="h-3 w-3/4" />
            </div>
          </div>
        </div>

        {/* Uptime monitors */}
        <div className="mb-8">
          <Sk className="mb-4 h-5 w-36" />
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="rounded-xl border border-line bg-surface p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <Sk className="h-4 w-32" />
                  <Sk className="h-4 w-16" />
                </div>
                {/* 90-day bar */}
                <div className="flex gap-0.5">
                  {Array.from({ length: 45 }).map((_, j) => (
                    <Sk key={j} className="h-6 flex-1 rounded-sm" />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Recent incidents */}
        <div>
          <Sk className="mb-4 h-5 w-40" />
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rounded-xl border border-line bg-surface p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <Sk className="h-4 w-44" />
                  <Sk className="h-3 w-20" />
                </div>
                <Sk className="h-3 w-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
