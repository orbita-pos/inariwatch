export default function Loading() {
  return (
    <div className="max-w-[680px] space-y-8 animate-pulse">
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 rounded-lg bg-zinc-800" />
        <div className="space-y-2">
          <div className="h-6 w-48 rounded bg-zinc-800" />
          <div className="h-4 w-24 rounded bg-zinc-900" />
        </div>
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between">
          <div className="h-3 w-28 rounded bg-zinc-800" />
          <div className="h-7 w-20 rounded-lg bg-zinc-800" />
        </div>
        <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] divide-y divide-[#131313]">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-5 py-3.5">
              <div className="h-8 w-8 rounded-full bg-zinc-800" />
              <div className="flex-1 space-y-1.5">
                <div className="h-4 w-32 rounded bg-zinc-800" />
                <div className="h-3 w-48 rounded bg-zinc-900" />
              </div>
              <div className="h-4 w-16 rounded bg-zinc-800" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
