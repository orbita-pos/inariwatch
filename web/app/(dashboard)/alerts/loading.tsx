function Sk({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-black/[0.08] dark:bg-white/[0.05] ${className ?? ""}`} />;
}

export default function AlertsLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1.5">
          <Sk className="h-6 w-20" />
          <Sk className="h-3 w-56" />
        </div>
      </div>

      <div className="rounded-xl border border-line overflow-hidden">
        {/* Header */}
        <div className="grid grid-cols-[24px_1fr_auto_auto] gap-3 border-b border-line bg-surface-dim px-4 py-2.5">
          <span />
          <Sk className="h-3 w-10" />
          <Sk className="h-3 w-12 hidden md:block" />
          <Sk className="h-3 w-10" />
        </div>

        {/* Rows */}
        <div className="divide-y divide-line-subtle bg-surface">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="grid grid-cols-[24px_1fr_auto_auto] items-center gap-3 px-4 py-3">
              <div className="flex justify-center">
                <Sk className="h-2 w-2 rounded-full" />
              </div>
              <div className="space-y-1.5">
                <Sk className={`h-3.5 ${i % 3 === 0 ? "w-3/4" : i % 3 === 1 ? "w-1/2" : "w-2/3"}`} />
                <Sk className="h-2.5 w-2/5" />
              </div>
              <Sk className="h-5 w-16 rounded hidden md:block" />
              <div className="text-right space-y-1">
                <Sk className="h-3 w-10 ml-auto" />
                <Sk className="h-2.5 w-12 ml-auto" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
