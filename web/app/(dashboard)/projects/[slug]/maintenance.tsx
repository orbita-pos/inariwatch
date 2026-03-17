"use client";

import { useState, useTransition } from "react";
import { Plus, Trash2, Wrench } from "lucide-react";
import { createMaintenanceWindow, deleteMaintenanceWindow } from "./actions";

interface MaintenanceWindow {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
}

interface MaintenanceSectionProps {
  projectId: string;
  isAdmin: boolean;
  windows: MaintenanceWindow[];
}

function getWindowStatus(w: MaintenanceWindow): "active" | "upcoming" | "past" {
  const now = new Date();
  if (now >= new Date(w.startsAt) && now <= new Date(w.endsAt)) return "active";
  if (now < new Date(w.startsAt)) return "upcoming";
  return "past";
}

function formatDateTime(d: Date): string {
  return new Date(d).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function MaintenanceSection({
  projectId,
  isAdmin,
  windows,
}: MaintenanceSectionProps) {
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    startTransition(async () => {
      const result = await createMaintenanceWindow(
        projectId,
        title,
        startsAt,
        endsAt
      );
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
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-widest text-zinc-500">
          Maintenance windows
        </h2>
        {isAdmin && (
          <button
            onClick={() => setShowForm(!showForm)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#222] bg-transparent px-3 py-1.5 text-[12px] font-medium text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 transition-all"
          >
            <Plus className="h-3.5 w-3.5" />
            Schedule
          </button>
        )}
      </div>

      <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] divide-y divide-[#131313]">
        {sortedWindows.map((w) => {
          const status = getWindowStatus(w);
          return (
            <div
              key={w.id}
              className={`flex items-center gap-3 px-5 py-3.5 ${
                status === "past" ? "opacity-40" : ""
              }`}
            >
              <div
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                  status === "active"
                    ? "bg-emerald-500/10 text-emerald-400"
                    : "bg-zinc-800 text-zinc-500"
                }`}
              >
                <Wrench className="h-3.5 w-3.5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm text-zinc-300 truncate">{w.title}</p>
                  {status === "active" && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                      Active
                    </span>
                  )}
                  {status === "upcoming" && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-400">
                      Upcoming
                    </span>
                  )}
                </div>
                <p className="text-xs text-zinc-600">
                  {formatDateTime(w.startsAt)} &mdash;{" "}
                  {formatDateTime(w.endsAt)}
                </p>
              </div>
              {isAdmin && (
                <button
                  onClick={() => handleDelete(w.id)}
                  disabled={isPending}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 hover:text-red-400 hover:bg-red-400/[0.06] transition-colors disabled:opacity-40"
                  title="Delete window"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          );
        })}

        {sortedWindows.length === 0 && (
          <div className="px-5 py-6 text-center">
            <p className="text-sm text-zinc-500">
              No maintenance windows scheduled. Alerts are suppressed during
              active windows.
            </p>
          </div>
        )}
      </div>

      {showForm && isAdmin && (
        <form
          onSubmit={handleCreate}
          className="mt-3 rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] px-5 py-4 space-y-3"
        >
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
              Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Database migration"
              required
              className="w-full rounded-lg border border-[#222] bg-[#111] px-3 py-2 text-sm text-zinc-100 placeholder-zinc-700 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                Start
              </label>
              <input
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                required
                className="w-full rounded-lg border border-[#222] bg-[#111] px-3 py-2 text-sm text-zinc-100 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors [color-scheme:dark]"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                End
              </label>
              <input
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
                required
                className="w-full rounded-lg border border-[#222] bg-[#111] px-3 py-2 text-sm text-zinc-100 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors [color-scheme:dark]"
              />
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
              className="flex-1 rounded-lg border border-[#222] px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="flex-1 rounded-lg bg-inari-accent px-3 py-2 text-sm font-medium text-white hover:bg-[#6D28D9] transition-colors disabled:opacity-40"
            >
              {isPending ? "Creating..." : "Create window"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
