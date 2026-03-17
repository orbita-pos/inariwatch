function Sk({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-black/[0.08] dark:bg-white/[0.05] ${className ?? ""}`} />;
}

export default function DashboardLoading() {
  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <Sk className="h-6 w-24" />
        <Sk className="h-4 w-28" />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-xl border border-line bg-surface px-5 py-4">
            <Sk className="h-3 w-16" />
            <Sk className="h-7 w-10" />
            <Sk className="h-2.5 w-20" />
          </div>
        ))}
      </div>

      {/* Alerts */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Sk className="h-4 w-28" />
          <Sk className="h-3 w-14" />
        </div>
        <div className="rounded-xl border border-line overflow-hidden divide-y divide-line-subtle bg-surface">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Sk className="h-2 w-2 rounded-full shrink-0" />
              <div className="flex-1 space-y-1.5">
                <Sk className={`h-3.5 ${i % 2 === 0 ? "w-2/3" : "w-1/2"}`} />
                <Sk className="h-2.5 w-1/3" />
              </div>
              <Sk className="h-3 w-14 hidden md:block" />
              <div className="text-right space-y-1">
                <Sk className="h-3 w-12" />
                <Sk className="h-2.5 w-8 ml-auto" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Projects */}
      <div className="space-y-3">
        <Sk className="h-4 w-20" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-line bg-surface p-4 space-y-3">
              <div className="flex items-center justify-between">
                <Sk className="h-4 w-24" />
                <Sk className="h-2 w-2 rounded-full" />
              </div>
              <Sk className="h-2.5 w-20" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
