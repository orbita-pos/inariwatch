"use client";

import { useTransition } from "react";
import { Trash2, Loader2 } from "lucide-react";
import { toggleChannel, deleteChannel, updateChannelMinSeverity } from "./actions";

export function ChannelToggle({ channelId, isActive }: { channelId: string; isActive: boolean }) {
  const [isPending, start] = useTransition();

  const handleToggle = () => {
    start(async () => {
      await toggleChannel(channelId, !isActive);
    });
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isActive}
      aria-label="Toggle notification channel"
      onClick={handleToggle}
      disabled={isPending}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
        isActive
          ? "border-inari-accent/30 bg-inari-accent/20"
          : "border-fg-base/20 bg-line"
      } ${isPending ? "opacity-50" : "cursor-pointer"}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full transition-transform ${
          isActive
            ? "translate-x-4 bg-inari-accent"
            : "translate-x-0.5 bg-fg-base/40"
        }`}
      />
    </button>
  );
}

export function ChannelDeleteButton({ channelId }: { channelId: string }) {
  const [isPending, start] = useTransition();

  const handleDelete = () => {
    if (!confirm("Remove this notification channel?")) return;
    start(async () => {
      await deleteChannel(channelId);
    });
  };

  return (
    <button
      type="button"
      onClick={handleDelete}
      disabled={isPending}
      className="text-fg-base/50 hover:text-red-600 dark:hover:text-red-400 transition-colors disabled:opacity-50"
      aria-label="Remove channel"
    >
      {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
    </button>
  );
}

const SEVERITY_OPTIONS = [
  { value: "info",     label: "All alerts" },
  { value: "warning",  label: "Warning & Critical" },
  { value: "critical", label: "Critical only" },
];

export function SeverityFilter({
  channelId,
  minSeverity,
}: {
  channelId: string;
  minSeverity: string;
}) {
  const [isPending, start] = useTransition();

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    start(async () => {
      await updateChannelMinSeverity(channelId, e.target.value);
    });
  };

  return (
    <select
      value={minSeverity}
      onChange={handleChange}
      disabled={isPending}
      className={`rounded-md border border-line-medium bg-surface-dim px-2 py-1 text-xs text-fg-base/60 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors ${
        isPending ? "opacity-50" : "cursor-pointer"
      }`}
      title="Minimum severity to notify"
    >
      {SEVERITY_OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
