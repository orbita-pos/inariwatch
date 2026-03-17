function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-zinc-800/60 ${className ?? ""}`} />;
}

export default function SignOutLoading() {
  return (
    <div className="relative flex min-h-screen items-center justify-center sm:justify-end bg-inari-bg">
      <div className="relative w-full max-w-sm px-4 py-12 sm:mr-16 lg:mr-24 xl:mr-32">
        <div className="mb-8 flex flex-col items-center gap-3">
          <Skeleton className="h-9 w-9 rounded-full" />
          <Skeleton className="h-3 w-32" />
        </div>
        <div className="rounded-2xl border border-inari-border bg-inari-card/90 p-8 space-y-4 text-center">
          <Skeleton className="mx-auto h-12 w-12 rounded-full" />
          <Skeleton className="mx-auto h-5 w-24" />
          <Skeleton className="mx-auto h-4 w-56" />
          <div className="space-y-3 mt-4">
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-10 w-full rounded-lg" />
          </div>
        </div>
      </div>
    </div>
  );
}
