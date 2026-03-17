function Sk({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-white/[0.05] ${className ?? ""}`} />;
}

export default function ProjectsLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1.5">
          <Sk className="h-6 w-24" />
          <Sk className="h-3 w-20" />
        </div>
        <Sk className="h-8 w-28 rounded-lg" />
      </div>

      <div className="rounded-xl border border-[#1a1a1a] overflow-hidden divide-y divide-[#131313] bg-[#0a0a0a]">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-5 py-4">
            <Sk className="h-2 w-2 rounded-full shrink-0" />

            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <Sk className="h-4 w-28" />
                <Sk className="h-3 w-20" />
              </div>
              <div className="flex gap-1.5">
                <Sk className="h-4 w-14 rounded" />
                <Sk className="h-4 w-12 rounded" />
              </div>
            </div>

            <div className="hidden sm:flex items-center gap-4">
              {Array.from({ length: 3 }).map((_, j) => (
                <div key={j} className="text-center space-y-1">
                  <Sk className="h-4 w-6 mx-auto" />
                  <Sk className="h-2.5 w-8 mx-auto" />
                </div>
              ))}
            </div>

            <div className="text-right space-y-1">
              <Sk className="h-3 w-32 ml-auto" />
              <Sk className="h-2.5 w-14 ml-auto" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
