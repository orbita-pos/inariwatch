function Sk({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-black/[0.08] dark:bg-white/[0.05] ${className ?? ""}`} />;
}

export default function EditPostLoading() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Header */}
      <Sk className="h-6 w-24" />

      {/* Form fields */}
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Sk className="h-3 w-10" />
          <Sk className="h-9 w-full rounded-lg" />
        </div>
        <div className="space-y-1.5">
          <Sk className="h-3 w-20" />
          <Sk className="h-9 w-full rounded-lg" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Sk className="h-3 w-8" />
            <Sk className="h-9 w-full rounded-lg" />
          </div>
          <div className="space-y-1.5">
            <Sk className="h-3 w-14" />
            <Sk className="h-9 w-full rounded-lg" />
          </div>
        </div>
        <div className="space-y-1.5">
          <Sk className="h-3 w-14" />
          <Sk className="h-64 w-full rounded-lg" />
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <Sk className="h-10 w-28 rounded-lg" />
        <Sk className="h-10 w-32 rounded-lg" />
      </div>
    </div>
  );
}
