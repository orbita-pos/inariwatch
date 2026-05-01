import { Button } from "@/components/ui";

const BILLING_URL = "https://app.inariwatch.com/settings";

export function SettingsAccount() {
  return (
    <section data-testid="settings-section-account" className="flex flex-col gap-4 max-w-xl">
      <header>
        <h2 className="font-[var(--font-serif)] text-xl">Account</h2>
        <p className="text-sm text-[var(--muted)]">
          Workspace + billing live on your InariWatch dashboard.
        </p>
      </header>

      <div className="flex items-center justify-between p-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]">
        <div>
          <div className="text-sm font-medium">Workspace</div>
          <div className="text-xs text-[var(--muted)]">Personal (default)</div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          data-testid="account-billing"
          onClick={() => {
            // Open in the user's default browser. Falls back to a plain
            // location if the Tauri shell plugin isn't wired (jsdom, dev).
            try {
              window.open(BILLING_URL, "_blank", "noopener");
            } catch {
              // ignored — UI shows the URL in a tooltip when click fails.
            }
          }}
        >
          Manage billing
        </Button>
      </div>

      <p className="text-xs text-[var(--muted)] font-mono">
        {BILLING_URL}
      </p>
    </section>
  );
}
