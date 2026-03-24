export default function FleetLoading() {
  return (
    <div className="space-y-8 animate-pulse">
      <div>
        <div className="h-6 w-32 rounded bg-surface-dim" />
        <div className="h-4 w-64 rounded bg-surface-dim mt-2" />
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="rounded-lg border border-line bg-surface p-4">
            <div className="h-3 w-20 rounded bg-surface-dim mb-3" />
            <div className="h-8 w-16 rounded bg-surface-dim" />
          </div>
        ))}
      </div>
      <div>
        <div className="h-5 w-48 rounded bg-surface-dim mb-3" />
        <div className="rounded-lg border border-line h-48 bg-surface" />
      </div>
      <div>
        <div className="h-5 w-48 rounded bg-surface-dim mb-3" />
        <div className="rounded-lg border border-line h-48 bg-surface" />
      </div>
    </div>
  );
}
