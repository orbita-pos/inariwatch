function Sk({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-black/[0.08] dark:bg-white/[0.05] ${className ?? ""}`} />;
}

function SectionSk({ rows }: { rows: number }) {
  return (
    <section className="space-y-3">
      <Sk className="h-3 w-24" />
      <div className="rounded-xl border border-line bg-surface px-5 py-1 divide-y divide-line-subtle">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center justify-between gap-4 py-3.5">
            <Sk className="h-3 w-24 shrink-0" />
            <Sk className="h-4 w-40 flex-1" />
          </div>
        ))}
      </div>
    </section>
  );
}

export default function SettingsLoading() {
  return (
    <div className="max-w-[680px] space-y-8">
      <Sk className="h-6 w-24" />
      <SectionSk rows={4} />
      <section className="space-y-3">
        <Sk className="h-3 w-36" />
        <div className="rounded-xl border border-line bg-surface px-5 divide-y divide-line-subtle">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 py-3">
              <Sk className="h-7 w-7 rounded-lg shrink-0" />
              <div className="flex-1 space-y-1.5">
                <Sk className="h-4 w-20" />
                <Sk className="h-3 w-32" />
              </div>
              <Sk className="h-3 w-10" />
            </div>
          ))}
        </div>
      </section>
      <SectionSk rows={2} />
    </div>
  );
}
