function Sk({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-black/[0.08] dark:bg-white/[0.05] ${className ?? ""}`} />;
}

export default function WorkspaceSettingsLoading() {
  return (
    <div className="mx-auto max-w-[680px] space-y-8">
      <div className="space-y-1.5">
        <Sk className="h-6 w-40" />
        <Sk className="h-3 w-56" />
      </div>

      {/* Workspace name section */}
      <section className="space-y-3">
        <Sk className="h-3 w-32" />
        <div className="rounded-xl border border-line bg-surface px-5 py-4 space-y-3">
          <Sk className="h-3 w-20" />
          <Sk className="h-9 w-full rounded-lg" />
          <Sk className="h-8 w-24 rounded-lg" />
        </div>
      </section>

      {/* Members section */}
      <section className="space-y-3">
        <Sk className="h-3 w-20" />
        <div className="rounded-xl border border-line bg-surface divide-y divide-line-subtle">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-5 py-3.5">
              <Sk className="h-8 w-8 rounded-full shrink-0" />
              <div className="flex-1 space-y-1.5">
                <Sk className={`h-3.5 ${i === 0 ? "w-32" : "w-44"}`} />
                <Sk className="h-2.5 w-36" />
              </div>
              <Sk className="h-6 w-16 rounded" />
            </div>
          ))}
        </div>
      </section>

      {/* Danger zone */}
      <section className="space-y-3">
        <Sk className="h-3 w-24" />
        <div className="rounded-xl border border-line bg-surface px-5 py-4 flex items-center justify-between gap-4">
          <div className="space-y-1.5">
            <Sk className="h-3.5 w-36" />
            <Sk className="h-3 w-56" />
          </div>
          <Sk className="h-8 w-28 rounded-lg shrink-0" />
        </div>
      </section>
    </div>
  );
}
