export default function Loading() {
  return (
    <div className="mx-auto max-w-[680px] space-y-8 animate-pulse">
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 rounded-lg bg-black/[0.08] dark:bg-white/[0.05]" />
        <div className="space-y-2">
          <div className="h-6 w-48 rounded bg-black/[0.08] dark:bg-white/[0.05]" />
          <div className="h-4 w-24 rounded bg-black/[0.06] dark:bg-white/[0.03]" />
        </div>
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between">
          <div className="h-3 w-28 rounded bg-black/[0.08] dark:bg-white/[0.05]" />
          <div className="h-7 w-20 rounded-lg bg-black/[0.08] dark:bg-white/[0.05]" />
        </div>
        <div className="rounded-xl border border-line bg-surface divide-y divide-line-subtle">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-5 py-3.5">
              <div className="h-8 w-8 rounded-full bg-black/[0.08] dark:bg-white/[0.05]" />
              <div className="flex-1 space-y-1.5">
                <div className="h-4 w-32 rounded bg-black/[0.08] dark:bg-white/[0.05]" />
                <div className="h-3 w-48 rounded bg-black/[0.06] dark:bg-white/[0.03]" />
              </div>
              <div className="h-4 w-16 rounded bg-black/[0.08] dark:bg-white/[0.05]" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
