import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui";
import {
  CloudError,
  cloudDevicesList,
  cloudDevicesRename,
  cloudDevicesRevoke,
  cloudDevicesSignOutAll,
  EVT_AUTH_REQUIRED,
  type DeviceRow,
} from "@/lib/cloud-ipc";

const OS_LABEL: Record<string, string> = {
  windows: "Windows",
  macos:   "macOS",
  linux:   "Linux",
};

type LoadState = "loading" | "ready" | "not_connected" | "error";

/**
 * Settings → Devices.
 *
 * Lists every active Inari Live device for the signed-in account.
 * "This device" gets a chip and is sorted to the top so the user can
 * find their current install at a glance. Each row supports rename
 * + revoke; the bottom of the panel offers sign-out-all (decoupled
 * from project tokens — see Session 1 brief).
 */
export function SettingsDevices() {
  const [state, setState]     = useState<LoadState>("loading");
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [error, setError]     = useState<string | null>(null);
  const [busy, setBusy]       = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const result = await cloudDevicesList();
      const sorted = [...result.devices].sort((a, b) => {
        if (a.isCurrent && !b.isCurrent) return -1;
        if (!a.isCurrent && b.isCurrent) return 1;
        return b.lastSeenAt.localeCompare(a.lastSeenAt);
      });
      setDevices(sorted);
      setState("ready");
    } catch (err) {
      if (err instanceof CloudError && err.kind === "not_connected") {
        setState("not_connected");
        return;
      }
      setState("error");
      setError(err instanceof Error ? err.message : "Failed to load devices");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Session 1 — clear list when bearer is invalidated (revoke from web,
  // server-side cleanup, etc). The backend emits `cloud-auth-required`
  // after wiping the keyring; refreshing turns the panel into the
  // "Not signed in" empty state without reload.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) return;
        const off = await listen(EVT_AUTH_REQUIRED, () => {
          void refresh();
        });
        if (cancelled) {
          off();
          return;
        }
        unlisten = off;
      } catch {
        /* tauri runtime not present — silent. */
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [refresh]);

  return (
    <section
      data-testid="settings-section-devices"
      className="flex flex-col gap-4 max-w-2xl"
    >
      <header>
        <h2 className="font-[var(--font-serif)] text-xl">Devices</h2>
        <p className="text-sm text-[var(--muted)]">
          Every Inari Live install signed in to your InariWatch account.
          Each device has its own token — revoking one doesn't affect the others.
        </p>
      </header>

      {state === "loading" ? (
        <p className="text-sm text-[var(--muted)]">Loading…</p>
      ) : state === "not_connected" ? (
        <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4 text-sm">
          <p className="text-[var(--text)]">Not signed in</p>
          <p className="mt-1 text-[var(--muted)]">
            Connect to InariWatch from Settings → Account to see your devices.
          </p>
        </div>
      ) : state === "error" ? (
        <div className="rounded-[var(--radius-md)] border border-[var(--danger)] bg-[var(--surface)] p-4 text-sm">
          <p className="text-[var(--danger)]">Couldn't load devices.</p>
          {error ? <p className="mt-1 text-[var(--muted)]">{error}</p> : null}
          <Button size="sm" variant="secondary" onClick={() => void refresh()} className="mt-3">
            Retry
          </Button>
        </div>
      ) : (
        <DeviceListView
          devices={devices}
          busyId={busy}
          onRename={async (id, label) => {
            setBusy(id);
            setError(null);
            try {
              await cloudDevicesRename(id, label);
              await refresh();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Rename failed");
            } finally {
              setBusy(null);
            }
          }}
          onRevoke={async (id, label) => {
            const yes = confirm(`Sign out "${label}"? This device will need to reconnect.`);
            if (!yes) return;
            setBusy(id);
            setError(null);
            try {
              await cloudDevicesRevoke(id);
              await refresh();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Revoke failed");
            } finally {
              setBusy(null);
            }
          }}
        />
      )}

      {state === "ready" && devices.length > 0 ? (
        <div className="pt-2 border-t border-[var(--border-subtle)]">
          <Button
            size="sm"
            variant="secondary"
            data-testid="settings-devices-sign-out-all"
            disabled={busy !== null}
            onClick={async () => {
              const yes = confirm(
                `Sign out all ${devices.length} device${devices.length === 1 ? "" : "s"}? Each will need to reconnect.`,
              );
              if (!yes) return;
              setBusy("__all__");
              setError(null);
              try {
                await cloudDevicesSignOutAll();
                await refresh();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Sign-out-all failed");
              } finally {
                setBusy(null);
              }
            }}
          >
            Sign out all devices
          </Button>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Revokes Inari Live tokens only. Project tokens in your host env vars
            are not affected.
          </p>
        </div>
      ) : null}

      {error ? (
        <p className="text-xs text-[var(--danger)]" data-testid="settings-devices-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

interface DeviceListViewProps {
  devices: DeviceRow[];
  busyId: string | null;
  onRename: (id: string, label: string) => Promise<void>;
  onRevoke: (id: string, label: string) => Promise<void>;
}

function DeviceListView({ devices, busyId, onRename, onRevoke }: DeviceListViewProps) {
  if (devices.length === 0) {
    return (
      <p className="text-sm text-[var(--muted)]">
        No devices yet. This shouldn't happen — try reconnecting from Account.
      </p>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]">
      {devices.map((d) => (
        <DeviceRowItem
          key={d.deviceId}
          device={d}
          busy={busyId === d.deviceId || busyId === "__all__"}
          onRename={(label) => onRename(d.deviceId, label)}
          onRevoke={() => onRevoke(d.deviceId, d.label)}
        />
      ))}
    </ul>
  );
}

interface DeviceRowItemProps {
  device: DeviceRow;
  busy: boolean;
  onRename: (label: string) => Promise<void>;
  onRevoke: () => Promise<void>;
}

function DeviceRowItem({ device, busy, onRename, onRevoke }: DeviceRowItemProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(device.label);

  return (
    <li className="flex items-center gap-3 p-3" data-testid={`settings-device-row-${device.deviceId}`}>
      <div className="flex-1 min-w-0">
        {editing ? (
          <div className="flex items-center gap-2">
            <input
              autoFocus
              type="text"
              maxLength={64}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setEditing(false);
                  setDraft(device.label);
                }
              }}
              className="flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
            <Button
              size="sm"
              variant="primary"
              disabled={busy || draft.trim().length === 0}
              onClick={async () => {
                await onRename(draft.trim());
                setEditing(false);
              }}
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setDraft(device.label);
              }}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-[var(--text)] truncate">
              {device.label}
            </span>
            {device.isCurrent ? (
              <span
                className="rounded-full border border-[var(--accent)] bg-transparent px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--accent)]"
                data-testid="settings-device-this-device"
              >
                This device
              </span>
            ) : null}
            {device.os ? (
              <span className="text-xs text-[var(--muted)]">
                · {OS_LABEL[device.os] ?? device.os}
              </span>
            ) : null}
          </div>
        )}
        {!editing ? (
          <p className="mt-0.5 text-xs text-[var(--muted)]">
            Last active {formatRelative(device.lastSeenAt)}
            {device.hostname && device.hostname !== device.label
              ? ` · ${device.hostname}`
              : ""}
          </p>
        ) : null}
      </div>

      {!editing ? (
        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => setEditing(true)}
            data-testid={`settings-device-rename-${device.deviceId}`}
          >
            Rename
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={onRevoke}
            data-testid={`settings-device-revoke-${device.deviceId}`}
          >
            Revoke
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** Cheap relative-time formatter — same shape as the web `formatRelativeTime`. */
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(1, Math.round((Date.now() - then) / 1000));
  if (seconds < 60)    return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60)    return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24)      return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30)       return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
