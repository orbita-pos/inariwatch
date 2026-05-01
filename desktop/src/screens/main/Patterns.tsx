export function MainPatterns() {
  return (
    <section data-testid="main-patterns" className="p-8 max-w-3xl">
      <h1 className="font-[var(--font-serif)] text-2xl mb-2">Patterns</h1>
      <p className="text-sm text-[var(--muted)]">
        <code>patterns.json</code> viewer with success / failure counts per
        fingerprint. Sesión 12 owns the writer; the read-only surface lands
        next session.
      </p>
    </section>
  );
}
