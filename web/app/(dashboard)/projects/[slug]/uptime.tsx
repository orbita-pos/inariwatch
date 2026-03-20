"use client";

import { useState, useTransition } from "react";
import { Plus, Trash2, Power, Globe, Activity, AlertCircle } from "lucide-react";
import { addMonitor, removeMonitor, toggleMonitor } from "./uptime-actions";

interface Monitor {
  id: string;
  url: string;
  name: string | null;
  intervalSec: number;
  expectedStatus: number;
  isActive: boolean;
  isDown: boolean;
  lastCheckedAt: Date | null;
  uptimePercent: number | null;
  avgResponseMs: number | null;
}

interface UptimeSectionProps {
  projectId: string;
  isAdmin: boolean;
  monitors: Monitor[];
}

const INTERVAL_OPTIONS = [
  { label: "Every 30s", value: 30 },
  { label: "Every 1 min", value: 60 },
  { label: "Every 2 min", value: 120 },
  { label: "Every 5 min", value: 300 },
];

function formatInterval(sec: number) {
  if (sec < 60) return `${sec}s`;
  return `${sec / 60}m`;
}

function formatMs(ms: number | null) {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatUptime(pct: number | null) {
  if (pct === null) return "—";
  return `${pct.toFixed(2)}%`;
}

export function UptimeSection({ projectId, isAdmin, monitors }: UptimeSectionProps) {
  const [showForm, setShowForm] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [intervalSec, setIntervalSec] = useState(60);
  const [expectedStatus, setExpectedStatus] = useState(200);
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    startTransition(async () => {
      const result = await addMonitor(projectId, url, name, intervalSec, expectedStatus);
      if (result.error) {
        setError(result.error);
      } else {
        setUrl("");
        setName("");
        setShowForm(false);
      }
    });
  };

  const handleRemove = (monitorId: string) => {
    startTransition(async () => {
      await removeMonitor(projectId, monitorId);
    });
  };

  const handleToggle = (monitorId: string, isActive: boolean) => {
    startTransition(async () => {
      await toggleMonitor(projectId, monitorId, !isActive);
    });
  };

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-widest text-zinc-500">
          Uptime Monitors
        </h2>
        {isAdmin && (
          <button
            onClick={() => setShowForm(!showForm)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line-medium bg-transparent px-3 py-1.5 text-[12px] font-medium text-zinc-400 hover:border-zinc-600 hover:text-fg-base transition-all"
          >
            <Plus className="h-3.5 w-3.5" />
            Add monitor
          </button>
        )}
      </div>

      <div className="rounded-xl border border-line bg-surface divide-y divide-line-subtle">
        {monitors.map((monitor) => (
          <div
            key={monitor.id}
            className={`flex items-center gap-3 px-5 py-3.5 ${
              !monitor.isActive ? "opacity-40" : ""
            }`}
          >
            {/* Status indicator */}
            <div
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                !monitor.isActive
                  ? "bg-zinc-800 text-zinc-500"
                  : monitor.isDown
                  ? "bg-red-500/10 text-red-400"
                  : "bg-emerald-500/10 text-emerald-400"
              }`}
            >
              {monitor.isDown ? (
                <AlertCircle className="h-3.5 w-3.5" />
              ) : (
                <Activity className="h-3.5 w-3.5" />
              )}
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm text-fg-base truncate">
                  {monitor.name ?? monitor.url}
                </p>
                <span
                  className={`inline-flex rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${
                    monitor.isDown
                      ? "bg-red-500/10 text-red-400"
                      : "bg-emerald-500/10 text-emerald-400"
                  }`}
                >
                  {monitor.isDown ? "Down" : "Up"}
                </span>
              </div>
              <p className="text-xs text-zinc-600 truncate">
                {monitor.url} · {formatInterval(monitor.intervalSec)} · {formatUptime(monitor.uptimePercent)} uptime · {formatMs(monitor.avgResponseMs)} avg
              </p>
            </div>

            {/* Actions */}
            {isAdmin && (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => handleToggle(monitor.id, monitor.isActive)}
                  disabled={isPending}
                  className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-40 ${
                    monitor.isActive
                      ? "text-emerald-400 hover:bg-emerald-400/[0.06]"
                      : "text-zinc-600 hover:text-zinc-400 hover:bg-zinc-400/[0.06]"
                  }`}
                  title={monitor.isActive ? "Pause" : "Resume"}
                >
                  <Power className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => handleRemove(monitor.id)}
                  disabled={isPending}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 hover:text-red-400 hover:bg-red-400/[0.06] transition-colors disabled:opacity-40"
                  title="Delete monitor"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        ))}

        {monitors.length === 0 && (
          <div className="px-5 py-6 text-center">
            <p className="text-sm text-zinc-500">
              No uptime monitors configured. Add one to start monitoring your endpoints.
            </p>
          </div>
        )}
      </div>

      {/* Add monitor form */}
      {showForm && isAdmin && (
        <form
          onSubmit={handleAdd}
          className="mt-3 rounded-xl border border-line bg-surface px-5 py-4 space-y-3"
        >
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
              URL to monitor
            </label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://api.myapp.com/health"
              required
              className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base placeholder-zinc-400 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
              Name (optional)
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Production API"
              className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base placeholder-zinc-400 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                Check interval
              </label>
              <select
                value={intervalSec}
                onChange={(e) => setIntervalSec(Number(e.target.value))}
                className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
              >
                {INTERVAL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                Expected status
              </label>
              <select
                value={expectedStatus}
                onChange={(e) => setExpectedStatus(Number(e.target.value))}
                className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
              >
                <option value={200}>200 OK</option>
                <option value={201}>201 Created</option>
                <option value={204}>204 No Content</option>
                <option value={301}>301 Redirect</option>
                <option value={302}>302 Redirect</option>
              </select>
            </div>
          </div>
          {error && (
            <p className="rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-2 text-[12px] text-red-400">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="flex-1 rounded-lg border border-line-medium px-3 py-2 text-sm text-zinc-400 hover:text-fg-base transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="flex-1 rounded-lg bg-inari-accent px-3 py-2 text-sm font-medium text-white hover:bg-[#6D28D9] transition-colors disabled:opacity-40"
            >
              {isPending ? "Adding..." : "Add monitor"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
