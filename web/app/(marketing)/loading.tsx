export default function MarketingLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-inari-bg">
      <div className="flex flex-col items-center gap-4">
        <span
          className="inari-dot text-4xl text-inari-accent glow-accent-text"
          style={{ animation: "none" }}
        >
          ◉
        </span>
        <p className="font-mono text-xs text-zinc-600 uppercase tracking-widest animate-pulse">
          Loading…
        </p>
      </div>
    </div>
  );
}
