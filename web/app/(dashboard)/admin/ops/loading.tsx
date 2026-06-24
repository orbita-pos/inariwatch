export default function Loading() {
  return (
    <div className="space-y-6">
      <div>
        <div className="h-7 w-24 rounded bg-surface-dim animate-pulse" />
        <div className="mt-2 h-4 w-2/3 rounded bg-surface-dim animate-pulse" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {Array.from({ length: 10 }).map((_, i) => (
          <div
            key={i}
            className={`h-40 rounded-xl border border-line bg-surface animate-pulse ${i === 0 || i === 3 || i === 8 ? "md:col-span-2" : ""}`}
          />
        ))}
      </div>
    </div>
  );
}
