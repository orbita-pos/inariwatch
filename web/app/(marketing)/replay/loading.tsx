function Sk({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-zinc-800/40 ${className ?? ""}`} />;
}

export default function ReplayLoading() {
  return (
    <div className="min-h-screen bg-page">
      <div className="mx-auto max-w-6xl px-6 pt-32 pb-20">
        {/* Hero */}
        <div className="text-center space-y-4 mb-20">
          <Sk className="mx-auto h-6 w-48 rounded-full" />
          <Sk className="mx-auto h-12 w-3/4 max-w-2xl" />
          <Sk className="mx-auto h-12 w-1/2 max-w-xl" />
          <Sk className="mx-auto h-4 w-2/3 max-w-xl mt-6" />
          <div className="flex items-center justify-center gap-3 pt-4">
            <Sk className="h-11 w-40 rounded-md" />
            <Sk className="h-11 w-40 rounded-md" />
          </div>
        </div>

        {/* Differentiators strip */}
        <div className="border-y border-line py-10 mb-16">
          <Sk className="mx-auto h-3 w-72 mb-7" />
          <div className="flex flex-wrap items-center justify-center gap-x-9 gap-y-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Sk key={i} className="h-4 w-40" />
            ))}
          </div>
        </div>

        {/* Player preview */}
        <div className="mb-20">
          <div className="text-center space-y-3 mb-12">
            <Sk className="mx-auto h-3 w-16" />
            <Sk className="mx-auto h-9 w-96" />
            <Sk className="mx-auto h-4 w-2/3 max-w-xl" />
          </div>
          <div className="rounded-2xl border border-line overflow-hidden">
            <Sk className="h-10 w-full rounded-none" />
            <Sk className="h-10 w-full rounded-none" />
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px]">
              <div>
                <Sk className="aspect-video w-full rounded-none" />
                <Sk className="h-12 w-full rounded-none" />
              </div>
              <div className="p-4 space-y-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Sk key={i} className={`h-3 ${i % 2 === 0 ? "w-3/4" : "w-1/2"}`} />
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Pillars */}
        <div className="grid md:grid-cols-3 gap-px bg-line mb-20">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="bg-surface p-8 space-y-3">
              <Sk className="h-9 w-9 rounded-lg" />
              <Sk className="h-4 w-40" />
              <Sk className="h-3 w-full" />
              <Sk className="h-3 w-2/3" />
            </div>
          ))}
        </div>

        {/* Comparison */}
        <div className="max-w-4xl mx-auto mb-20 space-y-3">
          <Sk className="mx-auto h-9 w-2/3" />
          <div className="rounded-xl border border-line overflow-hidden mt-8">
            <Sk className="h-10 w-full rounded-none" />
            {Array.from({ length: 7 }).map((_, i) => (
              <Sk key={i} className="h-12 w-full rounded-none" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
