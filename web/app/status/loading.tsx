function Sk({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-zinc-800/40 ${className ?? ""}`} />;
}

export default function StatusLoading() {
  return (
    <div className="min-h-screen bg-page">
      <div className="mx-auto max-w-3xl px-6 py-16">
        {/* Header */}
        <div className="mb-8 flex items-center gap-3">
          <Sk className="h-8 w-8 rounded" />
          <Sk className="h-6 w-36" />
        </div>

        {/* Overall status */}
        <div className="mb-8 rounded-xl border border-line bg-surface p-5 flex items-center gap-4">
          <Sk className="h-10 w-10 rounded-full" />
          <div className="space-y-1.5">
            <Sk className="h-5 w-40" />
            <Sk className="h-3 w-28" />
          </div>
        </div>

        {/* Services */}
        <div className="rounded-xl border border-line bg-surface divide-y divide-line">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between px-5 py-3.5">
              <div className="space-y-1">
                <Sk className="h-3.5 w-28" />
                <Sk className="h-2.5 w-40" />
              </div>
              <div className="flex items-center gap-2">
                <Sk className="h-5 w-20 rounded-full" />
                <Sk className="h-2.5 w-2.5 rounded-full" />
              </div>
            </div>
          ))}
        </div>

        {/* Project status pages */}
        <div className="mt-8">
          <Sk className="mb-4 h-5 w-36" />
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Sk key={i} className="h-10 w-full rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
