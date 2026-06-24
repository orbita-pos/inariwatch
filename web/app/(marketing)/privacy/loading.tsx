function Sk({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-zinc-800/40 ${className ?? ""}`} />;
}

export default function PrivacyLoading() {
  return (
    <div className="min-h-screen bg-page">
      <div className="mx-auto max-w-3xl px-6 py-24">
        {/* Title */}
        <Sk className="mb-2 h-8 w-48" />
        <Sk className="mb-10 h-3 w-36" />

        {/* Sections */}
        <div className="space-y-8">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="space-y-3">
              <Sk className="h-5 w-48" />
              <Sk className="h-3 w-full" />
              <Sk className="h-3 w-full" />
              <Sk className="h-3 w-5/6" />
              {i % 3 === 0 && (
                <div className="ml-4 space-y-2 mt-2">
                  <Sk className="h-3 w-3/4" />
                  <Sk className="h-3 w-2/3" />
                  <Sk className="h-3 w-3/4" />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
