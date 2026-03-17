function Skeleton({ className }: { className?: string }) {
  return (
    <div className={`animate-pulse rounded bg-zinc-800/60 ${className ?? ""}`} />
  );
}

export default function LoginLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-inari-bg px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <span className="inari-dot text-2xl text-inari-accent glow-accent-text">◉</span>
          <Skeleton className="h-3 w-36" />
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-inari-border bg-inari-card p-8 space-y-4">
          <Skeleton className="h-10 w-full rounded-lg" />

          <div className="flex items-center gap-3 py-2">
            <div className="flex-1 h-px bg-inari-border" />
            <Skeleton className="h-3 w-4" />
            <div className="flex-1 h-px bg-inari-border" />
          </div>

          <div className="space-y-1.5">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-10 w-full rounded-lg" />
          </div>
          <div className="space-y-1.5">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-10 w-full rounded-lg" />
          </div>
          <Skeleton className="h-10 w-full rounded-lg mt-2" />
        </div>

        <div className="mt-6 flex justify-center">
          <Skeleton className="h-3 w-48" />
        </div>
      </div>
    </div>
  );
}
