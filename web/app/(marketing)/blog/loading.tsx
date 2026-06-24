function Sk({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-zinc-800/40 ${className ?? ""}`} />;
}

export default function BlogLoading() {
  return (
    <div className="min-h-screen bg-page">
      <div className="mx-auto max-w-4xl px-6 py-24">
        {/* Header */}
        <div className="mb-12 space-y-3">
          <Sk className="h-8 w-64" />
          <Sk className="h-4 w-96" />
        </div>

        {/* Subscribe card */}
        <div className="mb-10 rounded-xl border border-line bg-surface p-6">
          <Sk className="mb-2 h-5 w-48" />
          <Sk className="mb-4 h-3 w-72" />
          <div className="flex gap-2">
            <Sk className="h-9 flex-1 rounded-lg" />
            <Sk className="h-9 w-28 rounded-lg" />
          </div>
        </div>

        {/* Post cards */}
        <div className="space-y-6">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-line bg-surface p-5 space-y-3">
              <div className="flex items-center gap-3">
                <Sk className="h-5 w-16 rounded-full" />
                <Sk className="h-3 w-20" />
              </div>
              <Sk className="h-5 w-3/4" />
              <Sk className="h-3 w-full" />
              <Sk className="h-3 w-2/3" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
