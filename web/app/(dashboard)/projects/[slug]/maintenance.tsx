"use client";

import { useState, useTransition, useId } from "react";
import { Plus, Trash2, Wrench } from "lucide-react";
import { createMaintenanceWindow, deleteMaintenanceWindow } from "./actions";

interface MaintenanceWindow {
  id:        string;
  title:     string;
  startsAt:  Date;
  endsAt:    Date;
  createdAt: Date;
}

interface MaintenanceSectionProps {
  projectId: string;
  isAdmin:   boolean;
  windows:   MaintenanceWindow[];
}

function getWindowStatus(w: MaintenanceWindow): "active" | "upcoming" | "past" {
  const now = new Date();
  if (now >= new Date(w.startsAt) && now <= new Date(w.endsAt)) return "active";
  if (now < new Date(w.startsAt)) return "upcoming";
  return "past";
}

function formatDateTime(d: Date): string {
  return new Date(d).toLocaleString("en-US", {
    month:  "short",
    day:    "numeric",
    year:   "numeric",
    hour:   "numeric",
    minute: "2-digit",
  });
}

export function MaintenanceSection({
  projectId,
  isAdmin,
  windows,
}: MaintenanceSectionProps) {
  const [showForm, setShowForm]         = useState(false);
  const [title, setTitle]               = useState("");
  const [startsAt, setStartsAt]         = useState("");
  const [endsAt, setEndsAt]             = useState("");
  const [error, setError]               = useState("");
  const [isPending, startTransition]    = useTransition();
  const titleId   = useId();
  const startsId  = useId();
  const endsId    = useId();
  const errorId   = useId();

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    startTransition(async () => {
      const result = await createMaintenanceWindow(projectId, title, startsAt, endsAt);
      if (result.error) {
        setError(result.error);
      } else {
        setTitle("");
        setStartsAt("");
        setEndsAt("");
        setShowForm(false);
      }
    });
  };

  const handleDelete = (windowId: string) => {
    startTransition(async () => {
      await deleteMaintenanceWindow(projectId, windowId);
    });
  };

  // Sort: active first, then upcoming, then past
  const sortedWindows = [...windows].sort((a, b) => {
    const order = { active: 0, upcoming: 1, past: 2 };
    const sa = order[getWindowStatus(a)];
    const sb = order[getWindowStatus(b)];
    if (sa !== sb) return sa - sb;
    return new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime();
  });

  return (
    <section aria-labelledby="maintenance-heading">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="maintenance-heading" className="text-xs font-medium uppercase tracking-widest text-fg-base/70">
          Maintenance windows
        </h2>
        {isAdmin && (
          <button
            type="button"
            onClick={() => setShowForm(!showForm)}
            aria-expanded={showForm}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line-medium bg-transparent px-3 py-1.5 text-[12px] font-medium text-fg-base hover:border-line hover:text-fg-strong hover:bg-surface transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Schedule
          </button>
        )}
      </div>

      <div className="rounded-xl border border-line bg-surface overflow-hidden">
        {sortedWindows.length > 0 ? (
          <ul className="divide-y divide-line-subtle">
            {sortedWindows.map((w) => {
              const status = getWindowStatus(w);
              return (
                <li
                  key={w.id}
                  className={`flex items-center gap-3 px-5 py-3.5 ${
                    status === "past" ? "opacity-60" : ""
                  }`}
                >
                  <div
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                      status === "active"
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        : "bg-surface-dim text-fg-base/60"
                    }`}
                    aria-hidden="true"
                  >
                    <Wrench className="h-3.5 w-3.5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm text-fg-strong truncate">{w.title}</p>
                      {status === "active" && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/25 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                          Active
                        </span>
                      )}
                      {status === "upcoming" && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 border border-amber-500/25 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
                          Upcoming
                        </span>
                      )}
                      {status === "past" && (
                        <span className="sr-only">Past window</span>
                      )}
                    </div>
                    <p className="text-xs text-fg-base/70">
                      <time dateTime={new Date(w.startsAt).toISOString()}>
                        {formatDateTime(w.startsAt)}
                      </time>
                      {" \u2014 "}
                      <time dateTime={new Date(w.endsAt).toISOString()}>
                        {formatDateTime(w.endsAt)}
                      </time>
                    </p>
                  </div>
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => handleDelete(w.id)}
                      disabled={isPending}
                      aria-label={`Delete maintenance window: ${w.title}`}
                      title={`Delete maintenance window: ${w.title}`}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-fg-base/60 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="px-5 py-6 text-center">
            <p className="text-sm text-fg-base">
              No maintenance windows scheduled. Alerts are suppressed during active windows.
            </p>
          </div>
        )}
      </div>

      {showForm && isAdmin && (
        <form
          onSubmit={handleCreate}
          aria-labelledby="maintenance-form-heading"
          className="mt-3 rounded-xl border border-line bg-surface px-5 py-4 space-y-3"
        >
          <h3 id="maintenance-form-heading" className="sr-only">Schedule a new maintenance window</h3>

          <div className="space-y-1.5">
            <label htmlFor={titleId} className="block text-[11px] font-medium uppercase tracking-wider text-fg-base/70">
              Title
            </label>
            <input
              id={titleId}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Database migration"
              required
              disabled={isPending}
              className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-strong placeholder:text-fg-base/40 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors disabled:opacity-60"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label htmlFor={startsId} className="block text-[11px] font-medium uppercase tracking-wider text-fg-base/70">
                Start
              </label>
              <input
                id={startsId}
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                required
                disabled={isPending}
                className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-strong focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors disabled:opacity-60"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor={endsId} className="block text-[11px] font-medium uppercase tracking-wider text-fg-base/70">
                End
              </label>
              <input
                id={endsId}
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
                required
                disabled={isPending}
                aria-describedby={error ? errorId : undefined}
                className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-strong focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors disabled:opacity-60"
              />
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
              {isPending ? "Creating…" : "Create window"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
