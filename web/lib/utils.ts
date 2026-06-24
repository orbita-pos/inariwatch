import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatRelativeTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const now = new Date();
  const diff = Math.floor((now.getTime() - d.getTime()) / 1000);

  if (diff < 60)   return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function severityColor(severity: string) {
  return {
    critical: "text-red-400",
    warning:  "text-yellow-400",
    info:     "text-blue-400",
  }[severity] ?? "text-zinc-400";
}

export function severityBg(severity: string) {
  return {
    critical: "bg-red-500/10 text-red-400 border-red-500/20",
    warning:  "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    info:     "bg-blue-500/10 text-blue-400 border-blue-500/20",
  }[severity] ?? "bg-zinc-800 text-zinc-400 border-zinc-700";
}
