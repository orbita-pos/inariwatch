function Sk({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-black/[0.08] dark:bg-white/[0.05] ${className ?? ""}`} />;
}

export default function AdminBlogLoading() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <Sk className="h-6 w-16" />
        <Sk className="h-9 w-24 rounded-lg" />
      </div>

      {/* Table */}
      <div className="rounded-xl border border-line overflow-hidden">
        <div className="grid grid-cols-[80px_60px_1fr_auto_auto] gap-3 border-b border-line bg-surface-dim px-4 py-2.5">
          <Sk className="h-3 w-12" />
          <Sk className="h-3 w-8" />
          <Sk className="h-3 w-10" />
          <Sk className="h-3 w-8" />
          <Sk className="h-3 w-14" />
        </div>
        <div className="divide-y divide-line-subtle bg-surface">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="grid grid-cols-[80px_60px_1fr_auto_auto] items-center gap-3 px-4 py-3">
              <Sk className={`h-5 w-16 rounded-full ${i % 2 === 0 ? "" : "w-12"}`} />
              <Sk className="h-5 w-12 rounded" />
              <Sk className={`h-3.5 ${i % 3 === 0 ? "w-3/4" : "w-1/2"}`} />
              <Sk className="h-8 w-14 rounded-lg" />
              <Sk className="h-8 w-14 rounded-lg" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
