function Sk({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-zinc-800/40 ${className ?? ""}`} />;
}

export default function DownloadLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-page">
      <div className="w-full max-w-md text-center space-y-6 px-6">
        {/* Logo */}
        <Sk className="mx-auto h-16 w-16 rounded-xl" />

        {/* Title + subtitle */}
        <div className="space-y-2">
          <Sk className="mx-auto h-7 w-48" />
          <Sk className="mx-auto h-3 w-64" />
        </div>

        {/* Feature cards */}
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-lg border border-line bg-surface p-3 space-y-2">
              <Sk className="h-5 w-5" />
              <Sk className="h-3 w-20" />
            </div>
          ))}
        </div>

        {/* Download buttons */}
        <div className="space-y-3">
          <Sk className="h-12 w-full rounded-lg" />
          <Sk className="h-12 w-full rounded-lg" />
        </div>

        {/* Version info */}
        <Sk className="mx-auto h-3 w-24" />
      </div>
    </div>
  );
}
