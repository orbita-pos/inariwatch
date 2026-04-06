function Sk({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-zinc-800/40 ${className ?? ""}`} />;
}

export default function InviteLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-page">
      <div className="w-full max-w-md rounded-xl border border-line bg-surface p-8 space-y-5">
        {/* Icon */}
        <Sk className="mx-auto h-12 w-12 rounded-full" />

        {/* Title + subtitle */}
        <div className="space-y-2 text-center">
          <Sk className="mx-auto h-6 w-52" />
          <Sk className="mx-auto h-3 w-64" />
        </div>

        {/* Invite details */}
        <div className="rounded-lg border border-line p-4 space-y-2">
          <div className="flex items-center justify-between">
            <Sk className="h-3 w-20" />
            <Sk className="h-3 w-32" />
          </div>
          <div className="flex items-center justify-between">
            <Sk className="h-3 w-12" />
            <Sk className="h-3 w-16" />
          </div>
        </div>

        {/* Accept button */}
        <Sk className="h-10 w-full rounded-lg" />
      </div>
    </div>
  );
}
