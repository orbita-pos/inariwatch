function Sk({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-zinc-800/40 ${className ?? ""}`} />;
}

export default function BlogPostLoading() {
  return (
    <div className="min-h-screen bg-page">
      <div className="mx-auto max-w-3xl px-6 py-24">
        {/* Back link */}
        <Sk className="mb-8 h-3 w-16" />

        {/* Hero image */}
        <Sk className="mb-8 h-64 w-full rounded-xl" />

        {/* Meta */}
        <div className="mb-4 flex items-center gap-3">
          <Sk className="h-5 w-16 rounded-full" />
          <Sk className="h-3 w-24" />
          <Sk className="h-3 w-20" />
        </div>

        {/* Title */}
        <Sk className="mb-2 h-8 w-full" />
        <Sk className="mb-6 h-8 w-2/3" />

        {/* Description */}
        <Sk className="mb-8 h-4 w-full" />

        {/* Article body */}
        <div className="space-y-4">
          <Sk className="h-3 w-full" />
          <Sk className="h-3 w-full" />
          <Sk className="h-3 w-5/6" />
          <Sk className="mt-6 h-5 w-48" />
          <Sk className="h-3 w-full" />
          <Sk className="h-3 w-full" />
          <Sk className="h-3 w-3/4" />
          <Sk className="mt-6 h-5 w-40" />
          <Sk className="h-3 w-full" />
          <Sk className="h-3 w-full" />
          <Sk className="h-3 w-2/3" />
        </div>
      </div>
    </div>
  );
}
