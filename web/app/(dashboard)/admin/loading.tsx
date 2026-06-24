function Sk({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-black/[0.08] dark:bg-white/[0.05] ${className ?? ""}`} />;
}

export default function AdminLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <Sk className="h-6 w-48" />
        <Sk className="h-3 w-72" />
      </div>

      <div className="rounded-xl border border-line overflow-hidden bg-surface">
        {/* Header */}
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 border-b border-line bg-surface-dim px-4 py-2.5">
          <Sk className="h-3 w-24" />
          <Sk className="h-3 w-16 hidden md:block" />
          <Sk className="h-3 w-20 hidden md:block" />
          <Sk className="h-3 w-10" />
        </div>

        {/* Rows */}
        <div className="divide-y divide-line-subtle">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 px-4 py-3.5">
              <div className="space-y-1.5">
                <Sk className={`h-3.5 ${i % 2 === 0 ? "w-2/3" : "w-1/2"}`} />
                <Sk className="h-2.5 w-2/5" />
              </div>
              <Sk className="h-5 w-14 rounded hidden md:block" />
              <Sk className="h-3 w-20 hidden md:block" />
              <Sk className="h-7 w-14 rounded-lg" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
