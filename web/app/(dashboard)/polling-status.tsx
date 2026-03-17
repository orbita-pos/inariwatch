"use client";

import { useEffect, useState } from "react";

function relativeTime(date: Date): string {
  const diff = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diff < 60)   return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

interface PollingStatusProps {
  lastCheckedAt: string | null; // ISO string from server
}

export function PollingStatus({ lastCheckedAt }: PollingStatusProps) {
  const [label, setLabel] = useState<string>(() => {
    if (!lastCheckedAt) return "Never polled";
    return relativeTime(new Date(lastCheckedAt));
  });

  useEffect(() => {
    if (!lastCheckedAt) return;
    const date = new Date(lastCheckedAt);
    const tick = () => setLabel(relativeTime(date));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [lastCheckedAt]);

  const isRecent = lastCheckedAt
    ? Date.now() - new Date(lastCheckedAt).getTime() < 10 * 60 * 1000
    : false;

  const isStale = lastCheckedAt
    ? Date.now() - new Date(lastCheckedAt).getTime() > 30 * 60 * 1000
    : true;

  const dotColor = !lastCheckedAt
    ? "bg-zinc-600"
    : isRecent
    ? "bg-emerald-500"
    : isStale
    ? "bg-yellow-500"
    : "bg-emerald-500";

  return (
    <div className="mx-2 mb-2 flex items-center gap-2 rounded-md px-3 py-2">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor} ${isRecent ? "shadow-[0_0_4px_1px] shadow-emerald-500/50" : ""}`} />
      <div className="min-w-0">
        <p className="text-[11px] text-zinc-500 leading-tight">Polling</p>
        <p className="text-[11px] text-zinc-600 leading-tight truncate">{label}</p>
      </div>
    </div>
  );
}
