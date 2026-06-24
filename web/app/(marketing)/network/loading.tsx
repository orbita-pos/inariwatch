function Sk({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-zinc-800/40 ${className ?? ""}`} />;
}

export default function NetworkLoading() {
  return (
    <div className="min-h-screen bg-page">
      <div className="mx-auto max-w-5xl px-6 py-24">
        {/* Hero */}
        <div className="mb-12 text-center space-y-3">
          <Sk className="mx-auto h-8 w-72" />
          <Sk className="mx-auto h-4 w-96" />
        </div>

        {/* Stats bar */}
        <div className="mb-16 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-line bg-surface p-4 text-center space-y-2">
              <Sk className="mx-auto h-7 w-16" />
              <Sk className="mx-auto h-3 w-20" />
            </div>
          ))}
        </div>

        {/* How it works */}
        <div className="mb-16">
          <Sk className="mx-auto mb-8 h-6 w-36" />
          <div className="grid gap-4 md:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="rounded-xl border border-line bg-surface p-5 space-y-3">
                <Sk className="h-10 w-10 rounded-lg" />
                <Sk className="h-5 w-32" />
                <Sk className="h-3 w-full" />
                <Sk className="h-3 w-3/4" />
              </div>
            ))}
          </div>
        </div>

        {/* Top patterns */}
        <div className="mb-16">
          <Sk className="mb-6 h-6 w-40" />
          <div className="space-y-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 rounded-lg border border-line bg-surface px-4 py-3">
                <Sk className="h-5 w-16 rounded-full" />
                <Sk className={`h-3 ${i % 2 === 0 ? "w-64" : "w-48"} flex-1`} />
                <Sk className="h-3 w-12" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
