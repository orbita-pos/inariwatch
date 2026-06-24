"use client";

import { useState, useTransition } from "react";
import { Monitor, Pencil, X } from "lucide-react";
import { renameDevice, revokeDevice, signOutAllDevices } from "./actions";
import { formatRelativeTime } from "@/lib/utils";

interface DeviceRow {
  deviceId:   string;
  label:      string;
  os:         string | null;
  hostname:   string | null;
  appVersion: string | null;
  createdAt:  string;
  lastSeenAt: string;
}

const OS_LABEL: Record<string, string> = {
  windows: "Windows",
  macos:   "macOS",
  linux:   "Linux",
};

export function DevicesSection({ initialDevices }: { initialDevices: DeviceRow[] }) {
  const [devices, setDevices] = useState(initialDevices);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function startEdit(d: DeviceRow) {
    setEditingId(d.deviceId);
    setEditValue(d.label);
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditValue("");
  }

  function saveEdit(deviceId: string) {
    const next = editValue.trim() || "Inari Live";
    startTransition(async () => {
      const result = await renameDevice(deviceId, next);
      if (result.error) {
        setError(result.error);
        return;
      }
      setDevices((curr) =>
        curr.map((d) => (d.deviceId === deviceId ? { ...d, label: next } : d)),
      );
      cancelEdit();
    });
  }

  function handleRevoke(deviceId: string, label: string) {
    if (!confirm(`Sign out "${label}"? This device will need to reconnect to InariWatch.`)) return;
    startTransition(async () => {
      const result = await revokeDevice(deviceId);
      if (result.error) {
        setError(result.error);
        return;
      }
      setDevices((curr) => curr.filter((d) => d.deviceId !== deviceId));
    });
  }

  function handleSignOutAll() {
    if (devices.length === 0) return;
    if (!confirm(
      `Sign out all ${devices.length} device${devices.length === 1 ? "" : "s"}? Each will need to reconnect.`,
    )) return;
    startTransition(async () => {
      const result = await signOutAllDevices();
      if (result.error) {
        setError(result.error);
        return;
      }
      setDevices([]);
    });
  }

  if (devices.length === 0) {
    return (
      <div className="py-4 text-center space-y-2">
        <p className="text-sm text-fg-base/60">No devices connected.</p>
        <p className="text-sm text-fg-base/50">
          Open Inari Live → Settings → Account → Connect to add a device.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 py-1">
      <div className="divide-y divide-line-subtle">
        {devices.map((d) => (
          <div key={d.deviceId} className="flex items-center gap-3 py-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line-medium bg-surface-dim text-fg-base/50">
              <Monitor className="h-4 w-4" aria-hidden="true" />
            </div>

            <div className="flex-1 min-w-0">
              {editingId === d.deviceId ? (
                <input
                  autoFocus
                  type="text"
                  maxLength={64}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveEdit(d.deviceId);
                    if (e.key === "Escape") cancelEdit();
                  }}
                  className="w-full rounded border border-line-medium bg-surface px-2 py-0.5 text-sm text-fg-base focus:outline-none focus:ring-1 focus:ring-cyan-500"
                />
              ) : (
                <p className="text-sm text-fg-base">
                  {d.label}
                  {d.os && (
                    <span className="ml-1.5 text-xs text-fg-base/50">
                      · {OS_LABEL[d.os] ?? d.os}
                    </span>
                  )}
                </p>
              )}
              <p className="text-xs text-fg-base/40">
                Last active {formatRelativeTime(new Date(d.lastSeenAt))}
                {d.hostname && d.hostname !== d.label && (
                  <span className="ml-1.5 font-mono text-fg-base/30">{d.hostname}</span>
                )}
              </p>
            </div>

            <div className="flex items-center gap-2">
              {editingId === d.deviceId ? (
                <>
                  <button
                    type="button"
                    onClick={() => saveEdit(d.deviceId)}
                    disabled={pending}
                    className="rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-xs font-medium text-cyan-600 hover:bg-cyan-500/20 disabled:opacity-50"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={cancelEdit}
                    disabled={pending}
                    className="rounded-md border border-line-medium px-2 py-0.5 text-xs font-medium text-fg-base/60 hover:bg-surface-dim disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => startEdit(d)}
                    aria-label={`Rename ${d.label}`}
                    title="Rename"
                    className="rounded-md p-1 text-fg-base/50 hover:bg-surface-dim hover:text-fg-base"
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRevoke(d.deviceId, d.label)}
                    aria-label={`Revoke ${d.label}`}
                    title="Revoke and remove"
                    disabled={pending}
                    className="rounded-md p-1 text-red-500 hover:bg-red-500/10 disabled:opacity-50"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {error && (
        <p className="text-xs text-red-500" role="alert">{error}</p>
      )}

      {devices.length > 0 && (
        <div className="pt-2">
          <button
            type="button"
            onClick={handleSignOutAll}
            disabled={pending}
            className="rounded-lg border border-red-500/30 bg-transparent px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-500/10 disabled:opacity-50"
          >
            Sign out all devices
          </button>
          <p className="mt-1.5 text-xs text-fg-base/50">
            Revokes Inari Live tokens only. Project tokens in your host env vars are not affected.
          </p>
        </div>
      )}
    </div>
  );
}
