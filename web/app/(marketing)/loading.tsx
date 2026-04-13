function Sk({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-zinc-800/40 ${className ?? ""}`} />;
}

export default function MarketingLoading() {
  return (
    <div className="min-h-screen bg-inari-bg">
      {/* Nav */}
      <div className="h-14 border-b border-line bg-inari-bg/80" />

      <div className="mx-auto max-w-5xl px-6">
        {/* Hero */}
        <div className="flex flex-col items-center pt-28 pb-16 space-y-5">
          <Sk className="h-6 w-32 rounded-full" />
          <Sk className="h-10 w-[480px] max-w-full" />
          <Sk className="h-10 w-[360px] max-w-full" />
          <Sk className="h-4 w-[520px] max-w-full mt-2" />
          <Sk className="h-4 w-[400px] max-w-full" />
          <div className="flex gap-3 mt-4">
            <Sk className="h-11 w-36 rounded-lg" />
            <Sk className="h-11 w-32 rounded-lg" />
          </div>
        </div>

        {/* Terminal mock */}
        <Sk className="mx-auto h-64 w-full max-w-2xl rounded-xl" />

        {/* Trusted by */}
        <div className="flex items-center justify-center gap-6 py-16">
          {Array.from({ length: 5 }).map((_, i) => (
            <Sk key={i} className="h-6 w-20 rounded" />
          ))}
        </div>

        {/* Feature grid */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 pb-20">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-line bg-surface p-5 space-y-3">
              <Sk className="h-8 w-8 rounded-lg" />
              <Sk className="h-4 w-32" />
              <Sk className="h-3 w-full" />
              <Sk className="h-3 w-4/5" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
