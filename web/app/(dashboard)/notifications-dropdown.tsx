"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import * as Popover from "@radix-ui/react-popover";
import { Bell, AlertTriangle, Info, Zap, ArrowRight, Loader2 } from "lucide-react";
import { getRecentNotifications, type NotificationItem } from "./notifications-actions";

function relativeTime(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60)    return "just now";
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const SEVERITY_ICON = {
  critical: <Zap        className="h-3.5 w-3.5 text-red-500" />,
  warning:  <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />,
  info:     <Info       className="h-3.5 w-3.5 text-blue-400" />,
};

const SEVERITY_DOT = {
  critical: "bg-red-500",
  warning:  "bg-yellow-500",
  info:     "bg-blue-400",
};

interface NotificationsBellProps {
  unreadCount: number;
}

export function NotificationsBell({ unreadCount }: NotificationsBellProps) {
  const [open,    setOpen]    = useState(false);
  const [items,   setItems]   = useState<NotificationItem[]>([]);
  const [loaded,  setLoaded]  = useState(false);
  const [pending, startTransition] = useTransition();

  function handleOpen(v: boolean) {
    setOpen(v);
    if (v && !loaded) {
      startTransition(async () => {
        const data = await getRecentNotifications();
        setItems(data);
        setLoaded(true);
      });
    }
  }

  const unread = items.filter((i) => !i.isRead);

  return (
    <Popover.Root open={open} onOpenChange={handleOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="relative flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:text-fg-strong hover:bg-surface-inner transition-colors"
          title="Notifications"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-inari-accent px-1 text-[9px] font-bold text-white leading-none">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-50 w-80 rounded-xl border border-line bg-surface shadow-lg shadow-black/10 dark:shadow-black/40 overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-line">
            <span className="text-sm font-semibold text-fg-strong">Notifications</span>
            {unread.length > 0 && (
              <span className="text-[11px] text-inari-accent font-medium">{unread.length} unread</span>
            )}
          </div>

          {/* List */}
          <div className="max-h-80 overflow-y-auto">
            {pending && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
              </div>
            )}

            {!pending && items.length === 0 && (
              <div className="flex flex-col items-center justify-center py-10 gap-2">
                <Bell className="h-6 w-6 text-zinc-600" />
                <p className="text-sm text-zinc-500">No notifications</p>
              </div>
            )}

            {!pending && items.map((item) => (
              <Link
                key={item.id}
                href={`/alerts/${item.id}`}
                onClick={() => setOpen(false)}
                className="flex items-start gap-3 px-4 py-3 hover:bg-surface-inner transition-colors border-b border-line last:border-0"
              >
                {/* Unread dot + severity icon */}
                <div className="relative mt-0.5 shrink-0">
                  {SEVERITY_ICON[item.severity]}
                  {!item.isRead && (
                    <span className={`absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full ${SEVERITY_DOT[item.severity]}`} />
                  )}
                </div>

                {/* Content */}
                <div className="min-w-0 flex-1">
                  <p className={`text-sm truncate leading-tight ${item.isRead ? "text-fg-base" : "text-fg-strong font-medium"}`}>
                    {item.title}
                  </p>
                  <p className="text-[11px] text-zinc-500 mt-0.5">{relativeTime(item.createdAt)}</p>
                </div>
              </Link>
            ))}
          </div>

          {/* Footer */}
          {items.length > 0 && (
            <div className="border-t border-line px-4 py-2.5">
              <Link
                href="/alerts"
                onClick={() => setOpen(false)}
                className="flex items-center justify-center gap-1.5 text-xs text-zinc-500 hover:text-fg-base transition-colors"
              >
                View all alerts
                <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
