function Sk({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-zinc-800/40 ${className ?? ""}`} />;
}

export default function PricingLoading() {
  return (
    <div className="min-h-screen bg-page">
      <div className="mx-auto max-w-4xl px-6 py-24">
        {/* Hero */}
        <div className="mb-12 text-center space-y-3">
          <Sk className="mx-auto h-6 w-24 rounded-full" />
          <Sk className="mx-auto h-9 w-72" />
          <Sk className="mx-auto h-4 w-96" />
        </div>

        {/* Pricing cards */}
        <div className="mb-16 grid gap-6 md:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-line bg-surface p-6 space-y-5">
              <div className="space-y-2">
                <Sk className="h-5 w-20" />
                <Sk className="h-9 w-28" />
                <Sk className="h-3 w-40" />
              </div>
              <Sk className="h-10 w-full rounded-lg" />
              <div className="space-y-2.5">
                {Array.from({ length: 10 }).map((_, j) => (
                  <div key={j} className="flex items-center gap-2">
                    <Sk className="h-4 w-4 rounded-full" />
                    <Sk className={`h-3 ${j % 3 === 0 ? "w-40" : j % 3 === 1 ? "w-52" : "w-36"}`} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* FAQ */}
        <div>
          <Sk className="mx-auto mb-8 h-6 w-48" />
          <div className="space-y-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rounded-xl border border-line bg-surface p-5 space-y-2">
                <Sk className="h-4 w-3/4" />
                <Sk className="h-3 w-full" />
                <Sk className="h-3 w-2/3" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
