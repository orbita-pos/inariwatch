function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-zinc-800/60 ${className ?? ""}`} />;
}

export default function ForgotPasswordLoading() {
  return (
    <div className="relative flex min-h-screen items-center justify-center sm:justify-end bg-inari-bg">
      <div className="relative w-full max-w-sm px-4 py-12 sm:mr-16 lg:mr-24 xl:mr-32">
        <div className="mb-8 flex flex-col items-center gap-3">
          <Skeleton className="h-9 w-9 rounded-full" />
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-5 w-48 mt-1" />
        </div>
        <div className="rounded-2xl border border-inari-border bg-inari-card/90 p-8 space-y-4">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <div className="space-y-1.5">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-10 w-full rounded-lg" />
          </div>
          <Skeleton className="h-10 w-full rounded-lg mt-2" />
        </div>
        <div className="mt-6 flex justify-center">
          <Skeleton className="h-3 w-40" />
        </div>
      </div>
    </div>
  );
}
