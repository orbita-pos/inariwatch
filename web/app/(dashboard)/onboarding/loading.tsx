function Sk({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-white/[0.05] ${className ?? ""}`} />;
}

export default function OnboardingLoading() {
  return (
    <div className="flex min-h-[calc(100vh-64px)] flex-col items-center justify-center px-4">
      <div className="w-full max-w-[540px]">
        {/* Progress bar skeleton */}
        <div className="mb-8">
          <Sk className="h-1 w-full rounded-full" />
        </div>

        {/* Step indicator skeleton */}
        <div className="mb-10 flex items-center justify-center gap-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex flex-col items-center gap-1.5">
              <Sk className="h-8 w-8 rounded-full" />
              <Sk className="h-3 w-14" />
            </div>
          ))}
        </div>

        {/* Content skeleton */}
        <div className="flex flex-col items-center text-center space-y-6">
          <Sk className="h-14 w-14 rounded-2xl" />
          <Sk className="h-6 w-48" />
          <Sk className="h-4 w-72" />
          <div className="w-full max-w-sm space-y-3">
            <Sk className="h-10 w-full rounded-lg" />
            <Sk className="h-12 w-full rounded-lg" />
          </div>
        </div>
      </div>
    </div>
  );
}
