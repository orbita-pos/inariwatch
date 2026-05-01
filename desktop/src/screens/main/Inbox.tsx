export function MainInbox() {
  return (
    <section data-testid="main-inbox" className="p-8 max-w-3xl">
      <h1 className="font-[var(--font-serif)] text-2xl mb-2">Inbox</h1>
      <p className="text-sm text-[var(--muted)]">
        Active alerts will surface here. Sesión 19 wires the real list — for
        now this is the empty-state.
      </p>
      <div className="mt-6 p-6 rounded-[var(--radius-md)] border border-dashed border-[var(--border)] text-sm text-[var(--muted)] text-center">
        No alerts in flight. Inari is watching.
      </div>
    </section>
  );
}
