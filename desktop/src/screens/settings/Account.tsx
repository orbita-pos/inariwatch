import { useCallback, useEffect, useState } from "react";

import {
  cloudAuthPoll,
  cloudAuthStart,
  cloudAuthStatus,
  cloudLogout,
  EVT_AUTH_REQUIRED,
  type AuthStatus,
} from "@/lib/cloud-ipc";

import {
  GhostButton,
  KvRow,
  SettingsField,
  SettingsGroup,
  SettingsHeader,
} from "./primitives";

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
      if (status.connected) {
        setLastSync(new Date());
        // Clear any stale "You were signed out" error left over from a
        // prior 401 event. The auth-required listener (below) is
        // optimistic — it surfaces the banner immediately. This refresh
        // is the authoritative confirmation: if the keyring still
        // resolves to a valid token + the server agrees, the banner
        // was a transient or already-resolved state.
        setError(null);
      }
    } catch {
      setState("disconnected");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Session 1 — when a 401 invalidates the bearer (revoke from web,
  // sign-out-all from another device, server cleared the row), the
  // backend emits `cloud-auth-required`. Refresh so the panel flips
  // to "Not connected" without the user having to click around.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) return;
        const off = await listen(EVT_AUTH_REQUIRED, () => {
          setError("You were signed out from web. Reconnect to continue.");
          void refresh();
        });
        if (cancelled) {
          off();
          return;
        }
        unlisten = off;
      } catch {
        /* tauri runtime not present — silent (vitest / jsdom path). */
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
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
      /* ignore */
    } finally {
      setState("disconnected");
      setLastSync(null);
    }
  }, []);

  const billingUrl = `${apiUrl.replace(/\/$/, "")}/settings`;

  return (
    <section data-testid="settings-section-account" className="flex flex-col">
      <SettingsHeader
        title="Account"
        description="Workspace + billing live on your InariWatch dashboard."
      />

      <div className="mt-6" />

      <SettingsGroup
        eyebrow="InariWatch Cloud"
        description={
          state === "connected"
            ? "Linked to your workspace. Receipts and alert state sync automatically."
            : "Optional. Connecting unlocks alerts, uptime, deploys, and on-call schedules in chat."
        }
      >
        <SettingsField
          first
          label="Cloud connection"
          helper={
            error ? (
              <span style={{ color: "var(--danger)" }} data-testid="settings-cloud-error">
                {error}
              </span>
            ) : state === "connected" ? (
              <span style={{ fontFamily: "var(--font-mono)" }}>{apiUrl}</span>
            ) : state === "connecting" ? (
              "Opening your browser to authorise this workstation…"
            ) : (
              "Not connected — chat works standalone but cloud-backed tools stay hidden."
            )
          }
          control={
            state === "connected" ? (
              <GhostButton
                testId="settings-cloud-disconnect"
                onClick={() => void handleDisconnect()}
              >
                Disconnect
              </GhostButton>
            ) : (
              <GhostButton
                testId="settings-cloud-connect"
                onClick={() => void handleConnect()}
              >
                {state === "connecting" ? "Connecting…" : "Connect"}
              </GhostButton>
            )
          }
        />
        {state === "connected" && lastSync ? (
          <div data-testid="settings-cloud-last-sync" className="mt-1">
            <KvRow k="last sync" v={lastSync.toISOString().slice(11, 19) + " UTC"} mono />
          </div>
        ) : null}
      </SettingsGroup>

      <SettingsGroup eyebrow="Workspace">
        <SettingsField
          first
          label="Personal workspace"
          helper={
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
              {billingUrl}
            </span>
          }
          control={
            <GhostButton
              testId="account-billing"
              onClick={() => {
                try {
                  window.open(billingUrl, "_blank", "noopener");
                } catch {
                  /* silent */
                }
              }}
            >
              Manage billing →
            </GhostButton>
          }
        />
      </SettingsGroup>
    </section>
  );
}
