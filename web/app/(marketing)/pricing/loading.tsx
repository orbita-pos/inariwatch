export default function PricingLoading() {
  return (
    <div className="min-h-screen bg-inari-bg animate-pulse">
      {/* Nav skeleton */}
      <div className="border-b border-inari-border px-6 py-4">
        <div className="mx-auto max-w-6xl flex items-center justify-between">
          <div className="h-4 w-28 rounded bg-surface-inner" />
          <div className="flex items-center gap-4">
            <div className="h-4 w-12 rounded bg-surface-inner" />
            <div className="h-8 w-24 rounded-lg bg-surface-inner" />
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-6 py-20">
        {/* Header */}
        <div className="text-center mb-16 space-y-4">
          <div className="h-3 w-16 rounded bg-surface-inner mx-auto" />
          <div className="h-10 w-72 rounded bg-surface-inner mx-auto" />
          <div className="h-5 w-96 rounded bg-surface-inner mx-auto" />
        </div>

        {/* Plan cards */}
        <div className="grid gap-6 lg:grid-cols-3 mb-20">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-2xl border border-inari-border bg-inari-card p-8 space-y-4">
              <div className="h-3 w-12 rounded bg-surface-inner" />
              <div className="h-10 w-20 rounded bg-surface-inner" />
              <div className="h-4 w-48 rounded bg-surface-inner" />
              <div className="h-10 w-full rounded-lg bg-surface-inner" />
              <div className="space-y-3 pt-4">
                {[0, 1, 2, 3, 4].map((j) => (
                  <div key={j} className="h-4 w-full rounded bg-surface-inner" />
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Comparison table */}
        <div className="mb-20">
          <div className="h-7 w-48 rounded bg-surface-inner mx-auto mb-8" />
          <div className="rounded-2xl border border-inari-border overflow-hidden">
            <div className="h-12 bg-inari-card border-b border-inari-border" />
            {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
              <div key={i} className="h-11 border-b border-inari-border last:border-0 bg-inari-bg" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
