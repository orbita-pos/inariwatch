// v0.3 S5 (Baileys rewrite) — Settings → WhatsApp Connection.
//
// Lists linked WhatsApp accounts (managed by `crate::whatsapp::SidecarManager`),
// supports adding new accounts via QR-pair flow, and supports
// disconnecting individual accounts.
//
// QR rendering uses `qrcode.react` (added to desktop/package.json in
// this session). The QR string itself is the raw Baileys pairing
// payload — `qrcode.react`'s `QRCodeSVG` encodes it the same way the
// official WhatsApp mobile app expects when scanning.
//
// All IPC calls + Tauri events are typed via `@/lib/main-ipc/whatsapp`.

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { QRCodeSVG } from "qrcode.react";

import { Button, Dialog, DialogClose, EmptyState, StatusPill } from "@/components/ui";

// ── Types (mirror desktop/src-tauri/src/whatsapp/types.rs) ────────────────

type ConnectionStatus =
  | "disconnected"
  | "qr_pending"
  | "connected"
  | "reconnecting"
  | "failed";

interface AccountInfo {
  account_id: string;
  label: string;
  self_jid: string | null;
  status: ConnectionStatus;
  last_qr_at_ms: number | null;
  last_linked_at_ms: number | null;
}

interface QrUpdateEvent {
  account_id: string;
  qr: string;
  ts_ms: number;
}

interface LinkedEvent {
  account_id: string;
  self_jid: string;
  ts_ms: number;
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  disconnected: "Disconnected",
  qr_pending: "QR pending",
  connected: "Connected",
  reconnecting: "Reconnecting",
  failed: "Failed",
};

const STATUS_VARIANT: Record<
  ConnectionStatus,
  "success" | "warning" | "danger" | "neutral"
> = {
  disconnected: "neutral",
  qr_pending: "warning",
  connected: "success",
  reconnecting: "warning",
  failed: "danger",
};

// ── Component ──────────────────────────────────────────────────────────────

export function SettingsWhatsApp() {
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pairingFor, setPairingFor] = useState<string | null>(null);
  const [pairingQr, setPairingQr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<AccountInfo[]>("whatsapp_list_accounts");
      setAccounts(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unlistenFns: Array<Promise<UnlistenFn>> = [
      listen<QrUpdateEvent>("whatsapp:qr-update", (event) => {
        if (event.payload.account_id === pairingFor) {
          setPairingQr(event.payload.qr);
        }
        void refresh();
      }),
      listen<LinkedEvent>("whatsapp:linked", () => {
        // Account paired — close the modal and refresh.
        setPairingFor(null);
        setPairingQr(null);
        void refresh();
      }),
      listen("whatsapp:logged-out", () => void refresh()),
      listen("whatsapp:connection-state-changed", () => void refresh()),
    ];
    return () => {
      unlistenFns.forEach((p) => p.then((fn) => fn()).catch(() => undefined));
    };
  }, [pairingFor, refresh]);

  const startLogin = useCallback(
    async (label: string) => {
      const id = `account-${Date.now().toString(36)}`;
      setPairingFor(id);
      setPairingQr(null);
      try {
        await invoke("whatsapp_login_start", { accountId: id, label });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPairingFor(null);
      }
    },
    [],
  );

  const logout = useCallback(
    async (accountId: string) => {
      try {
        await invoke("whatsapp_logout", { accountId });
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  const sortedAccounts = useMemo(
    () => [...accounts].sort((a, b) => a.label.localeCompare(b.label)),
    [accounts],
  );

  return (
    <section
      data-testid="settings-section-whatsapp"
      className="flex flex-col gap-5 max-w-xl"
    >
      <header>
        <h2 className="font-[var(--font-serif)] text-xl">WhatsApp Connection</h2>
        <p className="text-sm text-[var(--muted)]">
          Send incident alerts FROM your own WhatsApp account. Pair via QR code,
          one account per device.
        </p>
      </header>

      <TosWarning />

      {loading ? (
        <p className="text-sm text-[var(--muted)]">Loading accounts…</p>
      ) : null}
      {error ? (
        <p
          data-testid="whatsapp-error"
          className="text-sm rounded-[var(--radius-sm)] border border-[var(--danger)]/40 bg-[var(--danger)]/5 px-3 py-2"
        >
          {error}
        </p>
      ) : null}

      {sortedAccounts.length === 0 && !loading ? (
        <EmptyState
          headline="No WhatsApp accounts linked"
          helper="Click 'Add account' to pair your phone with Inari Live."
          testId="whatsapp-empty-state"
        />
      ) : (
        <ul data-testid="whatsapp-account-list" className="flex flex-col gap-2">
          {sortedAccounts.map((acc) => (
            <li
              key={acc.account_id}
              data-testid={`whatsapp-account-${acc.account_id}`}
              className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
            >
              <div className="flex flex-col">
                <span className="text-sm font-medium">{acc.label}</span>
                <span className="text-xs text-[var(--muted)]">
                  {acc.self_jid ?? "Not yet paired"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <StatusPill variant={STATUS_VARIANT[acc.status]}>
                  {STATUS_LABEL[acc.status]}
                </StatusPill>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => logout(acc.account_id)}
                  data-testid={`whatsapp-disconnect-${acc.account_id}`}
                >
                  Disconnect
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div>
        <Button
          variant="primary"
          onClick={() => startLogin(promptForLabel())}
          data-testid="whatsapp-add-account"
        >
          Add account
        </Button>
      </div>

      <Dialog
        open={pairingFor !== null}
        onOpenChange={(open) => {
          if (!open) {
            // User dismissed the modal — keep the session running in
            // the background; they can resume by clicking "Reconnect"
            // on the listed account.
            setPairingFor(null);
            setPairingQr(null);
          }
        }}
        title="Scan with WhatsApp"
        description="Open WhatsApp → Settings → Linked devices → Link a device. Then scan this code."
      >
        <div
          data-testid="whatsapp-pair-modal"
          className="flex flex-col gap-3 text-center"
        >
          <div
            data-testid="whatsapp-qr-canvas"
            className="self-center rounded-[var(--radius-md)] bg-white p-4"
          >
            {pairingQr ? (
              <QRCodeSVG value={pairingQr} size={224} level="M" />
            ) : (
              <span className="block w-56 h-56 grid place-items-center text-xs text-neutral-500">
                Waiting for QR…
              </span>
            )}
          </div>
          <p className="text-xs text-[var(--muted)]">
            QR refreshes every 20 seconds until paired.
          </p>
          <DialogClose asChild>
            <Button variant="ghost" size="sm" data-testid="whatsapp-pair-cancel">
              Cancel
            </Button>
          </DialogClose>
        </div>
      </Dialog>
    </section>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function promptForLabel(): string {
  // The native window.prompt is blocked in Tauri's webview by default.
  // For v0.3 we hard-code the first account's label and let the user
  // rename via Settings later. Keeping this isolated in a helper so a
  // future session can swap in a dialog-based prompt.
  const stamp = new Date().toLocaleDateString();
  return `Personal (${stamp})`;
}

function TosWarning() {
  return (
    <div
      data-testid="whatsapp-tos-warning"
      className="rounded-[var(--radius-md)] border border-[var(--warn)]/40 bg-[var(--warn)]/5 px-3 py-2 text-xs"
    >
      <strong>TOS gray area.</strong> Inari Live connects DIRECTLY to your
      WhatsApp account using the same WebSocket protocol the mobile app uses.
      This is fine for low-volume incident alerts but Meta MAY ban accounts
      that send marketing-shaped traffic or message non-contacts at high
      volume. Outbound is rate-limited to 80&nbsp;msg/sec/account.
    </div>
  );
}
