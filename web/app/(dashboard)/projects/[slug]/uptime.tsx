"use client";

import { useState, useTransition, useId } from "react";
import { Plus, Trash2, Power, Activity, AlertCircle } from "lucide-react";
import { addMonitor, removeMonitor, toggleMonitor } from "./uptime-actions";

interface Monitor {
  id:              string;
  url:             string;
  name:            string | null;
  intervalSec:     number;
  expectedStatus:  number;
  isActive:        boolean;
  isDown:          boolean;
  lastCheckedAt:   Date | null;
  uptimePercent:   number | null;
  avgResponseMs:   number | null;
}

interface UptimeSectionProps {
  projectId: string;
  isAdmin:   boolean;
  monitors:  Monitor[];
}

const INTERVAL_OPTIONS = [
  { label: "Every 30s",  value: 30 },
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
  const [showForm, setShowForm]       = useState(false);
  const [url, setUrl]                 = useState("");
  const [name, setName]               = useState("");
  const [intervalSec, setIntervalSec] = useState(60);
  const [expectedStatus, setExpectedStatus] = useState(200);
  const [error, setError]             = useState("");
  const [isPending, startTransition]  = useTransition();

  const uid        = useId();
  const urlId      = `${uid}-url`;
  const nameId     = `${uid}-name`;
  const intervalId = `${uid}-interval`;
  const statusId   = `${uid}-status`;
  const errorId    = `${uid}-error`;

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
    <section aria-labelledby="uptime-heading">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="uptime-heading" className="text-xs font-medium uppercase tracking-widest text-fg-base/70">
          Uptime Monitors
        </h2>
        {isAdmin && (
          <button
            type="button"
            onClick={() => setShowForm(!showForm)}
            aria-expanded={showForm}
            aria-controls="uptime-form"
            className="inline-flex items-center gap-1.5 rounded-lg border border-line-medium bg-transparent px-3 py-1.5 text-[12px] font-medium text-fg-base hover:border-line hover:text-fg-strong hover:bg-surface transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add monitor
          </button>
        )}
      </div>

      <div className="rounded-xl border border-line bg-surface overflow-hidden">
        {monitors.length > 0 ? (
          <ul className="divide-y divide-line-subtle">
            {monitors.map((monitor) => {
              const monitorLabel = monitor.name ?? monitor.url;
              return (
                <li
                  key={monitor.id}
                  className={`flex items-center gap-3 px-5 py-3.5 ${!monitor.isActive ? "opacity-40" : ""}`}
                >
                  {/* Status indicator */}
                  <div
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                      !monitor.isActive
                        ? "bg-surface-dim text-fg-base/60"
                        : monitor.isDown
                        ? "bg-red-500/10 text-red-600 dark:text-red-400"
                        : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    }`}
                    aria-hidden="true"
                  >
                    {monitor.isDown ? (
                      <AlertCircle className="h-3.5 w-3.5" />
                    ) : (
                      <Activity className="h-3.5 w-3.5" />
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm text-fg-base truncate">{monitorLabel}</p>
                      <span
                        className={`inline-flex rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${
                          monitor.isDown
                            ? "bg-red-500/10 text-red-700 dark:text-red-400"
                            : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                        }`}
                      >
                        {monitor.isDown ? "Down" : "Up"}
                      </span>
                    </div>
                    <p className="text-xs text-fg-base/70 truncate">
                      {monitor.url} · {formatInterval(monitor.intervalSec)} · {formatUptime(monitor.uptimePercent)} uptime · {formatMs(monitor.avgResponseMs)} avg
                    </p>
                  </div>

                  {/* Actions */}
                  {isAdmin && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleToggle(monitor.id, monitor.isActive)}
                        disabled={isPending}
                        aria-label={monitor.isActive ? `Pause ${monitorLabel}` : `Resume ${monitorLabel}`}
                        aria-pressed={monitor.isActive}
                        className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50 ${
                          monitor.isActive
                            ? "text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
                            : "text-fg-base/60 hover:text-fg-base hover:bg-surface-inner"
                        }`}
                      >
                        <Power className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemove(monitor.id)}
                        disabled={isPending}
                        aria-label={`Delete ${monitorLabel} monitor`}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-fg-base/60 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="px-5 py-6 text-center">
            <p className="text-sm text-fg-base/70">
              No uptime monitors configured. Add one to start monitoring your endpoints.
            </p>
          </div>
        )}
      </div>

      {/* Add monitor form */}
      {showForm && isAdmin && (
        <form
          id="uptime-form"
          onSubmit={handleAdd}
          aria-labelledby="uptime-form-heading"
          className="mt-3 rounded-xl border border-line bg-surface px-5 py-4 space-y-3"
        >
          <h3 id="uptime-form-heading" className="sr-only">Add uptime monitor</h3>

          <div className="space-y-1.5">
            <label htmlFor={urlId} className="block text-[11px] font-medium uppercase tracking-wider text-fg-base/70">
              URL to monitor
            </label>
            <input
              id={urlId}
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://api.myapp.com/health"
              required
              disabled={isPending}
              aria-describedby={error ? errorId : undefined}
              className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base placeholder:text-fg-base/40 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors disabled:opacity-60"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor={nameId} className="block text-[11px] font-medium uppercase tracking-wider text-fg-base/70">
              Name <span className="normal-case font-normal">(optional)</span>
            </label>
            <input
              id={nameId}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Production API"
              disabled={isPending}
              className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base placeholder:text-fg-base/40 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors disabled:opacity-60"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label htmlFor={intervalId} className="block text-[11px] font-medium uppercase tracking-wider text-fg-base/70">
                Check interval
              </label>
              <select
                id={intervalId}
                value={intervalSec}
                onChange={(e) => setIntervalSec(Number(e.target.value))}
                disabled={isPending}
                className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors disabled:opacity-60"
              >
                {INTERVAL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor={statusId} className="block text-[11px] font-medium uppercase tracking-wider text-fg-base/70">
                Expected status
              </label>
              <select
                id={statusId}
                value={expectedStatus}
                onChange={(e) => setExpectedStatus(Number(e.target.value))}
                disabled={isPending}
                className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors disabled:opacity-60"
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
            <p
              id={errorId}
              role="alert"
              className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12px] text-red-700 dark:text-red-400"
            >
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => { setShowForm(false); setError(""); }}
              disabled={isPending}
              className="flex-1 rounded-lg border border-line-medium px-3 py-2 text-sm text-fg-base hover:text-fg-strong hover:border-line transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              aria-busy={isPending}
              className="flex-1 rounded-lg bg-inari-accent px-3 py-2 text-sm font-medium text-white hover:bg-inari-accent/90 transition-colors disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
            >
              {isPending ? "Adding…" : "Add monitor"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
