"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessageSquare, Plus } from "lucide-react";

import { cn, formatRelativeTime } from "@/lib/utils";
import { FilterChips, type SidebarFilter } from "./filter-chips";
import type { ConversationListRow } from "./types";

interface InboxSidebarProps {
  initialConversations: ConversationListRow[];
}

/**
 * Sidebar inbox — filter chips + status-grouped conversation list.
 *
 * Visual contract (matches `desktop/src/screens/Settings.tsx` rail
 * pattern): groups separated by 1px hairlines, group headings in
 * uppercase mono with letter-spacing, active row marked by a left
 * accent strip. Chips are ghost-style single-select.
 *
 * Hydration:
 *   * Server renders the initial list; client takes over and opens
 *     `/api/conversations/event-stream` for live updates (created /
 *     state). On `created` we prepend; on `state` we patch in place.
 *   * Filter changes refetch via the existing list endpoint — keeping
 *     the SSE connection scoped to "what's new" instead of trying to
 *     replay a filter on the wire.
 */
export function InboxSidebar({ initialConversations }: InboxSidebarProps) {
  const pathname = usePathname();
  const activeId = (() => {
    const m = pathname?.match(/\/c\/([^/]+)/);
    return m ? m[1] : null;
  })();

  const [filter, setFilter]            = useState<SidebarFilter>("all");
  const [conversations, setConversations] = useState<ConversationListRow[]>(initialConversations);
  const [loading, setLoading]          = useState(false);
  const lastFilterRef                  = useRef<SidebarFilter>("all");

  // Refetch on filter change.
  const refresh = useCallback(async (f: SidebarFilter) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("state", "all");
      if (f === "critical") params.set("severity", "critical");
      if (f === "mine")     params.set("mine", "1");
      if (f === "snoozed")  params.set("state", "snoozed");
      const res = await fetch(`/api/conversations?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { conversations: ConversationListRow[] };
      setConversations(json.conversations);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (filter === lastFilterRef.current) return;
    lastFilterRef.current = filter;
    void refresh(filter);
  }, [filter, refresh]);

  // Workspace SSE — live updates for created + state changes.
  useEffect(() => {
    let cancelled = false;
    const es = new EventSource("/api/conversations/event-stream", { withCredentials: true });

    const onCreated = (ev: MessageEvent) => {
      if (cancelled) return;
      try {
        const payload = JSON.parse(ev.data) as {
          conversationId: string;
          anchorAlertId: string | null;
          title: string;
          state: string;
          workspaceId: string | null;
          at: string;
        };
        setConversations((prev) => {
          if (prev.some((c) => c.id === payload.conversationId)) return prev;
          const next: ConversationListRow = {
            id:                      payload.conversationId,
            title:                   payload.title,
            state:                   (payload.state as ConversationListRow["state"]) ?? "active",
            anchorAlertId:           payload.anchorAlertId,
            lastMessageAt:           payload.at,
            snoozedUntil:            null,
            resolvedAt:              null,
            workspaceId:             payload.workspaceId,
            alertSeverity:           null,
            alertSourceIntegrations: null,
            unreadHint:              true,
          };
          return [next, ...prev];
        });
      } catch { /* ignore malformed payload */ }
    };

    const onState = (ev: MessageEvent) => {
      if (cancelled) return;
      try {
        const payload = JSON.parse(ev.data) as { conversationId: string; state: string };
        setConversations((prev) =>
          prev.map((c) =>
            c.id === payload.conversationId
              ? { ...c, state: payload.state as ConversationListRow["state"] }
              : c,
          ),
        );
      } catch { /* ignore */ }
    };

    es.addEventListener("created", onCreated);
    es.addEventListener("state", onState);
    return () => {
      cancelled = true;
      es.removeEventListener("created", onCreated);
      es.removeEventListener("state", onState);
      es.close();
    };
  }, []);

  // Group + filter for render.
  const groups = useMemo(() => groupByState(conversations), [conversations]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <MessageSquare aria-hidden className="h-4 w-4 text-fg-base/60 shrink-0" />
          <span className="text-sm font-medium text-fg-strong truncate">Inbox</span>
          {loading ? (
            <span className="text-[10px] text-fg-base/50 font-mono uppercase">syncing</span>
          ) : null}
        </div>
        <Link
          href="/c"
          className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-dim px-2 py-1 text-[11px] font-medium text-fg-base hover:text-fg-strong hover:border-line-medium transition-colors"
        >
          <Plus aria-hidden className="h-3 w-3" />
          New
        </Link>
      </header>

      <div className="px-3 py-3 border-b border-line-subtle">
        <FilterChips value={filter} onChange={setFilter} />
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {conversations.length === 0 ? (
          <p className="text-xs text-fg-base/50 px-4 py-6">No conversations yet.</p>
        ) : (
          <ul className="flex flex-col">
            {groups.map((group) => (
              <li key={group.label}>
                <div
                  className="px-4 pt-3 pb-1 text-[10px] font-semibold tracking-[0.16em] uppercase text-fg-base/50"
                >
                  {group.label}
                </div>
                <ul className="flex flex-col">
                  {group.items.map((row) => (
                    <li key={row.id}>
                      <ConversationRow row={row} active={row.id === activeId} />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ConversationRow({ row, active }: { row: ConversationListRow; active: boolean }) {
  const sevDot =
    row.alertSeverity === "critical" ? "bg-inari-accent" :
    row.alertSeverity === "warning"  ? "bg-amber-500" :
    row.alertSeverity === "info"     ? "bg-blue-500" :
    "bg-line-medium";

  return (
    <Link
      href={`/c/${row.id}`}
      className={cn(
        "group relative flex items-start gap-3 px-4 py-3 transition-colors",
        active ? "bg-black/[0.025] dark:bg-white/[0.025]" : "hover:bg-black/[0.025] dark:hover:bg-white/[0.025]",
      )}
      aria-current={active ? "page" : undefined}
    >
      {active ? (
        <span
          aria-hidden
          className="absolute left-0 top-3 bottom-3 w-[2px] rounded-r-full bg-inari-accent"
        />
      ) : null}
      <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", sevDot)} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-1.5">
          {row.unreadHint ? (
            <span aria-hidden className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-inari-accent" />
          ) : null}
          <p className={cn(
            "text-sm leading-snug line-clamp-2",
            active ? "text-fg-strong font-medium" : "text-fg-base group-hover:text-fg-strong",
          )}>
            {row.title}
          </p>
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-fg-base/60">
          <span className="font-mono">{formatRelativeTime(new Date(row.lastMessageAt))}</span>
          {row.alertSourceIntegrations && row.alertSourceIntegrations[0] ? (
            <>
              <span>·</span>
              <span className="font-mono">{row.alertSourceIntegrations[0]}</span>
            </>
          ) : null}
          {row.state === "snoozed" ? (
            <>
              <span>·</span>
              <span className="text-amber-500">snoozed</span>
            </>
          ) : null}
          {row.state === "resolved" ? (
            <>
              <span>·</span>
              <span className="text-emerald-600 dark:text-emerald-400">resolved</span>
            </>
          ) : null}
        </div>
      </div>
    </Link>
  );
}

interface Group {
  label: string;
  items: ConversationListRow[];
}

function groupByState(rows: ConversationListRow[]): Group[] {
  const startOfDay = startOfToday();
  const active:    ConversationListRow[] = [];
  const snoozed:   ConversationListRow[] = [];
  const resolvedToday: ConversationListRow[] = [];
  const archived:  ConversationListRow[] = [];

  for (const row of rows) {
    if (row.state === "active")       active.push(row);
    else if (row.state === "snoozed") snoozed.push(row);
    else if (row.state === "archived") archived.push(row);
    else if (row.state === "resolved") {
      const ts = row.resolvedAt ? new Date(row.resolvedAt).getTime() : 0;
      if (ts >= startOfDay) resolvedToday.push(row);
    }
  }

  const groups: Group[] = [];
  if (active.length)         groups.push({ label: `Active · ${active.length}`,           items: active });
  if (snoozed.length)        groups.push({ label: `Snoozed · ${snoozed.length}`,         items: snoozed });
  if (resolvedToday.length)  groups.push({ label: `Resolved today · ${resolvedToday.length}`, items: resolvedToday });
  if (archived.length)       groups.push({ label: `Archived · ${archived.length}`,       items: archived });
  return groups;
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
