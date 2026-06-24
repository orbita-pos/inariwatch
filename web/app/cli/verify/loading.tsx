function Sk({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-zinc-800/40 ${className ?? ""}`} />;
}

export default function CLIVerifyLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-page">
      <div className="w-full max-w-md rounded-xl border border-line bg-surface p-8 space-y-5">
        {/* Icon */}
        <Sk className="mx-auto h-14 w-14 rounded-full" />

        {/* Title + description */}
        <div className="space-y-2 text-center">
          <Sk className="mx-auto h-6 w-40" />
          <Sk className="mx-auto h-3 w-56" />
        </div>

        {/* Info box */}
        <div className="rounded-lg border border-line p-4 space-y-2">
          <Sk className="h-3 w-full" />
          <Sk className="h-3 w-3/4" />
          <Sk className="h-3 w-5/6" />
        </div>

        {/* Button */}
        <Sk className="h-10 w-full rounded-lg" />

        {/* Email info */}
        <Sk className="mx-auto h-3 w-36" />
      </div>
    </div>
  );
}
