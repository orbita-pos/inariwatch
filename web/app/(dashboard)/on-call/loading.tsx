function Sk({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-black/[0.08] dark:bg-white/[0.05] ${className ?? ""}`} />;
}

export default function OnCallLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <Sk className="h-6 w-24" />
        <Sk className="h-3 w-64" />
      </div>

      <div className="rounded-xl border border-line overflow-hidden bg-surface">
        {/* Header */}
        <div className="border-b border-line bg-surface-dim px-4 py-3 flex items-center gap-3">
          <Sk className="h-4 w-4 rounded" />
          <Sk className="h-3 w-28" />
        </div>

        {/* Project rows */}
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-line-subtle px-4 py-4 last:border-0">
            <Sk className="h-8 w-8 rounded-lg shrink-0" />
            <div className="flex-1 space-y-1.5">
              <Sk className={`h-4 ${i % 2 === 0 ? "w-40" : "w-56"}`} />
              <Sk className="h-3 w-28" />
            </div>
            <Sk className="h-6 w-20 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
