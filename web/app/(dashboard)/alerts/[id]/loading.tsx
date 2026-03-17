export default function AlertDetailLoading() {
  return (
    <div className="max-w-[740px] space-y-6 animate-pulse">
      {/* Back */}
      <div className="h-4 w-28 rounded bg-white/[0.05]" />

      {/* Header card */}
      <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] overflow-hidden">
        <div className="h-[3px] w-full bg-white/[0.05]" />
        <div className="px-6 py-5 space-y-3">
          <div className="flex gap-2">
            <div className="h-4 w-16 rounded bg-white/[0.05]" />
            <div className="h-4 w-16 rounded bg-white/[0.05]" />
          </div>
          <div className="h-6 w-3/4 rounded bg-white/[0.05]" />
          <div className="h-4 w-1/2 rounded bg-white/[0.05]" />
          <div className="flex gap-2">
            <div className="h-6 w-20 rounded bg-white/[0.05]" />
            <div className="h-6 w-20 rounded bg-white/[0.05]" />
          </div>
        </div>
        <div className="border-t border-[#1a1a1a] bg-[#080808] px-6 py-3">
          <div className="h-7 w-32 rounded bg-white/[0.05]" />
        </div>
      </div>

      {/* Body */}
      <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] overflow-hidden">
        <div className="border-b border-[#1a1a1a] px-5 py-3">
          <div className="h-3 w-16 rounded bg-white/[0.05]" />
        </div>
        <div className="px-5 py-4 space-y-2">
          <div className="h-4 w-full rounded bg-white/[0.05]" />
          <div className="h-4 w-5/6 rounded bg-white/[0.05]" />
          <div className="h-4 w-4/6 rounded bg-white/[0.05]" />
        </div>
      </div>

      {/* Meta */}
      <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] overflow-hidden">
        <div className="border-b border-[#1a1a1a] px-5 py-3">
          <div className="h-3 w-20 rounded bg-white/[0.05]" />
        </div>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="grid grid-cols-[140px_1fr] gap-4 px-5 py-2.5 border-b border-[#131313]">
            <div className="h-3.5 rounded bg-white/[0.05]" />
            <div className="h-3.5 rounded bg-white/[0.05]" />
          </div>
        ))}
      </div>
    </div>
  );
}
