function Sk({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-black/[0.08] dark:bg-white/[0.05] ${className ?? ""}`} />;
}

export default function ReplaySessionLoading() {
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-1.5">
          <Sk className="h-3 w-20" />
          <Sk className="h-6 w-56" />
        </div>
        <div className="flex items-center gap-2">
          <Sk className="h-5 w-16 rounded-full" />
          <Sk className="h-5 w-20 rounded-full" />
          <Sk className="h-5 w-24 rounded-full" />
          <Sk className="h-5 w-20 rounded-full" />
          <Sk className="h-5 w-16 rounded-full" />
        </div>
      </div>

      {/* Player + side panel */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        <div className="rounded-xl border border-line bg-surface overflow-hidden">
          {/* Controls */}
          <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
            <Sk className="h-7 w-7 rounded-full" />
            <Sk className="h-2 flex-1 rounded-full" />
            <Sk className="h-3 w-16" />
          </div>
          {/* Stage */}
          <Sk className="h-[480px] w-full rounded-none" />
          {/* Timeline canvas */}
          <div className="border-t border-line p-3 space-y-2">
            <Sk className="h-3 w-full" />
            <Sk className="h-3 w-full" />
          </div>
        </div>

        {/* Side panel (console / network / nav) */}
        <div className="rounded-xl border border-line bg-surface p-3 space-y-3">
          <div className="flex items-center gap-2">
            <Sk className="h-6 w-16 rounded-md" />
            <Sk className="h-6 w-16 rounded-md" />
            <Sk className="h-6 w-12 rounded-md" />
          </div>
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2">
                <Sk className="h-3 w-10" />
                <Sk className={`h-3 ${i % 2 === 0 ? "flex-1" : "w-3/4"}`} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Breadcrumb / nav strip */}
      <div className="rounded-xl border border-line bg-surface p-3">
        <Sk className="h-4 w-24 mb-2" />
        <div className="flex items-center gap-2 overflow-hidden">
          {Array.from({ length: 5 }).map((_, i) => (
            <Sk key={i} className="h-6 w-24 shrink-0 rounded-md" />
          ))}
        </div>
      </div>
    </div>
  );
}
