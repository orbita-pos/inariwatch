"use client";

import { useTransition } from "react";
import { CheckCheck } from "lucide-react";
import { markAllAlertsRead } from "./actions";

export function MarkAllReadButton({ unread }: { unread: number }) {
  const [isPending, start] = useTransition();

  if (unread === 0) return null;

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => start(() => markAllAlertsRead())}
      className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-fg-base hover:text-fg-strong hover:border-line-medium transition-colors disabled:opacity-50"
    >
      <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
      {isPending ? "Marking..." : "Mark all read"}
    </button>
  );
}
