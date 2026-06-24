function Sk({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-black/[0.08] dark:bg-white/[0.05] ${className ?? ""}`} />;
}

export default function RecordingLoading() {
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-1.5">
          <Sk className="h-5 w-16" />
          <Sk className="h-6 w-48" />
        </div>
        <div className="flex items-center gap-3">
          <Sk className="h-5 w-20 rounded-full" />
          <Sk className="h-5 w-24 rounded-full" />
        </div>
      </div>

      {/* Player area */}
      <div className="rounded-xl border border-line bg-surface overflow-hidden">
        {/* Controls bar */}
        <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
          <Sk className="h-7 w-7 rounded-full" />
          <Sk className="h-2 flex-1 rounded-full" />
          <Sk className="h-3 w-16" />
        </div>
        {/* Video area */}
        <Sk className="h-[480px] w-full rounded-none" />
      </div>

      {/* Event timeline */}
      <div className="rounded-xl border border-line bg-surface p-4 space-y-3">
        <Sk className="h-4 w-20" />
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Sk className="h-3 w-14" />
              <Sk className="h-5 w-16 rounded-full" />
              <Sk className={`h-3 ${i % 2 === 0 ? "w-48" : "w-36"}`} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
