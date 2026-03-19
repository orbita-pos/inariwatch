function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <div className={`animate-pulse rounded bg-zinc-800/50 ${className ?? ""}`} style={style} />
  );
}

function SkeletonLine({ w = "full" }: { w?: string }) {
  return <Skeleton className={`h-3.5 w-${w} rounded`} />;
}

export default function DocsLoading() {
  return (
    <div className="min-h-screen bg-inari-bg">
      {/* Nav placeholder */}
      <div className="h-14 border-b border-line bg-inari-bg/80 backdrop-blur-md" />

      <div className="mx-auto max-w-6xl px-6 pt-20">
        <div className="flex gap-10 lg:gap-16">

          {/* ── Sidebar skeleton ──────────────────────────────────── */}
          <aside className="hidden lg:block w-52 shrink-0 sticky top-20 h-[calc(100vh-5rem)] overflow-hidden">
            <div className="py-6 space-y-6">
              {[5, 3, 6, 6, 4, 2, 2].map((count, gi) => (
                <div key={gi} className="space-y-1.5">
                  {/* Group label */}
                  <Skeleton className="h-2 w-24 mb-2.5" />
                  {/* Nav items */}
                  {Array.from({ length: count }).map((_, i) => (
                    <Skeleton
                      key={i}
                      className="h-7 w-full rounded-md"
                      style={{ opacity: 1 - i * 0.08 } as React.CSSProperties}
                    />
                  ))}
                </div>
              ))}
            </div>
          </aside>

          {/* ── Content skeleton ──────────────────────────────────── */}
          <main className="min-w-0 flex-1 py-8 pb-32">

            {/* Page header */}
            <div className="mb-10 border-b border-line pb-8 space-y-3">
              <Skeleton className="h-2.5 w-28" />
              <Skeleton className="h-8 w-64" />
              <Skeleton className="h-3.5 w-96 max-w-full" />
            </div>

            {/* Section 1 */}
            <div className="space-y-3 mb-8">
              <Skeleton className="h-6 w-48 mt-10 border-t border-line pt-10" />
              <SkeletonLine w="full" />
              <SkeletonLine w="5/6" />
              <SkeletonLine w="4/6" />

              {/* Step list */}
              <div className="my-4 space-y-4">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="flex gap-4">
                    <Skeleton className="h-6 w-6 shrink-0 rounded-full" />
                    <div className="flex-1 space-y-1.5 pt-0.5">
                      <Skeleton className="h-3.5 w-36" />
                      <Skeleton className="h-3 w-full" />
                      <Skeleton className="h-3 w-4/5" />
                    </div>
                  </div>
                ))}
              </div>

              {/* Callout */}
              <Skeleton className="h-12 w-full rounded-lg" />
            </div>

            {/* Section 2 */}
            <div className="space-y-3 mb-8">
              <Skeleton className="h-6 w-36 mt-10" />
              <SkeletonLine w="full" />
              <SkeletonLine w="3/4" />

              {/* Code block */}
              <Skeleton className="h-24 w-full rounded-lg my-4" />

              {/* Step list */}
              <div className="my-4 space-y-4">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex gap-4">
                    <Skeleton className="h-6 w-6 shrink-0 rounded-full" />
                    <div className="flex-1 space-y-1.5 pt-0.5">
                      <Skeleton className="h-3.5 w-40" />
                      <Skeleton className="h-3 w-5/6" />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Section 3 — table-like */}
            <div className="space-y-3 mb-8">
              <Skeleton className="h-6 w-52 mt-10" />
              <SkeletonLine w="full" />

              {/* Table skeleton */}
              <div className="my-4 rounded-lg border border-line overflow-hidden">
                <Skeleton className="h-9 w-full rounded-none" />
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="flex gap-4 px-4 py-2.5 border-t border-line-subtle">
                    <Skeleton className="h-3 w-2/5" />
                    <Skeleton className="h-3 w-1/5" />
                    <Skeleton className="h-3 w-1/5" />
                  </div>
                ))}
              </div>
            </div>

            {/* Section 4 */}
            <div className="space-y-3">
              <Skeleton className="h-6 w-44 mt-10" />
              <SkeletonLine w="full" />
              <SkeletonLine w="4/5" />
              <Skeleton className="h-32 w-full rounded-lg my-4" />
            </div>

          </main>
        </div>
      </div>
    </div>
  );
}
