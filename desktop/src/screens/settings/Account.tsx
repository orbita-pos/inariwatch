import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui";
import {
  cloudAuthPoll,
  cloudAuthStart,
  cloudAuthStatus,
  cloudLogout,
  type AuthStatus,
} from "@/lib/cloud-ipc";

const BILLING_URL_FALLBACK = "https://app.inariwatch.com/settings";

type ConnectState = "checking" | "disconnected" | "connecting" | "connected";

export function SettingsAccount() {
  const [state, setState] = useState<ConnectState>("checking");
  const [apiUrl, setApiUrl] = useState<string>(BILLING_URL_FALLBACK);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    try {
      const status: AuthStatus = await cloudAuthStatus();
      setState(status.connected ? "connected" : "disconnected");
      setApiUrl(status.api_url || BILLING_URL_FALLBACK);
      if (status.connected) setLastSync(new Date());
    } catch {
      // Tauri runtime not present (jsdom / preview) — render disconnected
      // so this section degrades cleanly without throwing.
      setState("disconnected");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleConnect = useCallback(async () => {
    setState("connecting");
    setError(null);
    try {
      const started = await cloudAuthStart();
      await cloudAuthPoll(started.code, started.api_url);
      await refresh();
    } catch (err) {
      setState("disconnected");
      setError(err instanceof Error ? err.message : "Connection failed");
    }
  }, [refresh]);

  const handleDisconnect = useCallback(async () => {
    try {
      await cloudLogout();
    } catch {
      /* ignore — settings already cleared on success */
    } finally {
      setState("disconnected");
      setLastSync(null);
    }
  }, []);

  const billingUrl = `${apiUrl.replace(/\/$/, "")}/settings`;

  return (
    <section
      data-testid="settings-section-account"
      className="flex flex-col gap-4 max-w-xl"
    >
      <header>
        <h2 className="font-[var(--font-serif)] text-xl">Account</h2>
        <p className="text-sm text-[var(--muted)]">
          Workspace + billing live on your InariWatch dashboard.
        </p>
      </header>

      <div
        className="flex flex-col gap-3 p-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]"
        data-testid="settings-cloud-connection"
        data-state={state}
      >
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">InariWatch Cloud</div>
            <div className="text-xs text-[var(--muted)]">
              {state === "connected"
                ? `Connected to ${apiUrl}`
                : state === "connecting"
                  ? "Opening browser…"
                  : "Not connected — alerts, uptime, deploys, on-call all hidden."}
            </div>
            {state === "connected" && lastSync ? (
              <div
                className="text-[0.65rem] text-[var(--muted)] mt-1"
                data-testid="settings-cloud-last-sync"
              >
                Last sync: {lastSync.toISOString()}
              </div>
            ) : null}
          </div>
          {state === "connected" ? (
            <Button
              size="sm"
              variant="secondary"
              data-testid="settings-cloud-disconnect"
              onClick={handleDisconnect}
            >
              Disconnect
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              data-testid="settings-cloud-connect"
              onClick={handleConnect}
              disabled={state === "connecting" || state === "checking"}
            >
              {state === "connecting" ? "Connecting…" : "Connect"}
            </Button>
          )}
        </div>
        {error ? (
          <p className="text-xs text-[var(--danger)]" data-testid="settings-cloud-error">
            {error}
          </p>
        ) : null}
      </div>

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
            try {
              window.open(billingUrl, "_blank", "noopener");
            } catch {
              // ignored — UI shows the URL in a tooltip when click fails.
            }
          }}
        >
          Manage billing
        </Button>
      </div>

      <p className="text-xs text-[var(--muted)] font-mono">{billingUrl}</p>
    </section>
  );
}
