/**
 * Inari Live — Inbox surface (overlay over the chat).
 *
 * Visual contract: matches the Claude-designed reference at
 * `~/Downloads/Inari Live - Inbox.html` (states A/B/C). Each row shows
 * severity dot · title + project + snippet · status pill · time · arrow.
 * Filter chips with counts on top, search trigger linked to the
 * command palette, J/K + arrow-key navigation, Enter to open.
 *
 * Inbox is a full-screen overlay (z-50 in MainWindow) on top of the
 * chat surface. Esc returns to chat. Click a row → conversation
 * viewer overlay (z-60) on top of inbox.
 *
 * Data shape: cloudConversationsList from cloud-ipc. We added
 * `lastMessageSnippet` + `lastMessageRole` in the same session so the
 * row's two-liner ("Inari: opened PR #4187…") works without an extra
 * fetch per row.
 *
 * Filters: All / Firing / Snoozed / Resolved / My turn. The counts are
 * computed client-side from the current page — accurate for what the
 * user sees, not the global tail. "My turn" maps to the existing
 * `mine` filter on the cloud endpoint.
 */

import { listen } from "@tauri-apps/api/event"
import {
  ArrowRight,
  Bell,
  ChevronDown,
  Inbox as InboxIcon,
  Moon,
  Search,
  Settings,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  cloudConversationsList,
  EVT_CONVERSATION_EVENT,
  type ConversationListRow,
  type ConversationState,
} from "@/lib/cloud-ipc"
import { useCommandPalette } from "@/lib/store/commandPalette"

interface InboxOverlayProps {
  /** Click handler when a row is selected. */
  onSelect?: (id: string) => void
  /** Called by the overlay shell to dismiss itself. */
  onClose: () => void
  testId?: string
}

type Filter = "all" | "firing" | "snoozed" | "resolved" | "mine"

export function MainInbox({ onSelect, onClose, testId }: InboxOverlayProps) {
  const openPalette = useCommandPalette((s) => s.openWithIntent)
  const [rows, setRows] = useState<ConversationListRow[]>([])
  const [filter, setFilter] = useState<Filter>("all")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // Fetch on filter change. Maps the local Filter union to the cloud
  // endpoint's parameters. "firing" + "resolved" map to state filters;
  // "mine" toggles the `mine` flag; "all" sends no state filter.
  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params: Parameters<typeof cloudConversationsList>[0] = {}
      if (filter === "firing") params.state = "active"
      else if (filter === "snoozed") params.state = "snoozed"
      else if (filter === "resolved") params.state = "resolved"
      else if (filter === "mine") params.mine = true
      const result = await cloudConversationsList(params)
      setRows(result.conversations)
      setSelectedIndex(0)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === "not_connected") {
        setError("Sign in from Settings → Account to see your inbox.")
      } else if (msg === "unauthorized") {
        setError("Session expired — re-pair from Settings → Account.")
      } else {
        setError(msg)
      }
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Live updates via Tauri-forwarded SSE. Workspace-level events
  // (conversationId === null) trigger a full refetch; per-conversation
  // events are ignored here (the conversation viewer handles them).
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | null = null
    ;(async () => {
      try {
        const off = await listen<{ event: string; data: string; conversationId: string | null }>(
          EVT_CONVERSATION_EVENT,
          (e) => {
            if (cancelled) return
            if (e.payload.conversationId !== null) return
            void refresh()
          },
        )
        if (cancelled) {
          off()
          return
        }
        unlisten = off
      } catch {
        /* tauri runtime unavailable in jsdom — silent */
      }
    })()
    return () => {
      cancelled = true
      if (unlisten) unlisten()
    }
  }, [refresh])

  // Counts come from the current page — accurate for what the user
  // sees. We don't ask the server for global counts because the
  // command palette `Cmd+K` and detail panel already cover "is there
  // an alert I'm missing globally" — the filter chips are about
  // narrowing the page in front of you.
  const counts = useMemo(() => {
    const c = { all: rows.length, firing: 0, snoozed: 0, resolved: 0, mine: 0 }
    for (const r of rows) {
      if (r.state === "active") c.firing += 1
      else if (r.state === "snoozed") c.snoozed += 1
      else if (r.state === "resolved") c.resolved += 1
    }
    return c
  }, [rows])

  // Keyboard navigation — Gmail/Linear pattern. J/K and ↑/↓ move the
  // selection; Enter opens; Esc closes the inbox. We bypass when the
  // user is typing in a text input so the palette / search field
  // still work.
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      const isInput =
        tag === "input" || tag === "textarea" || (target?.isContentEditable ?? false)
      if (isInput) return

      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
        return
      }
      if (rows.length === 0) return

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault()
        setSelectedIndex((i) => Math.min(i + 1, rows.length - 1))
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === "Enter") {
        e.preventDefault()
        const row = rows[selectedIndex]
        if (row) onSelect?.(row.id)
      } else if (e.key === "g" || e.key === "Home") {
        e.preventDefault()
        setSelectedIndex(0)
      } else if (e.key === "G" || e.key === "End") {
        e.preventDefault()
        setSelectedIndex(rows.length - 1)
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [rows, selectedIndex, onSelect, onClose])

  // Scroll selected row into view when arrow keys move past the
  // viewport. `block: "nearest"` avoids the page jumping for rows
  // that are already visible.
  useEffect(() => {
    const container = listRef.current
    if (!container) return
    const row = container.querySelector<HTMLElement>(
      `[data-inbox-row-index="${selectedIndex}"]`,
    )
    if (row) row.scrollIntoView({ block: "nearest" })
  }, [selectedIndex])

  return (
    <section
      data-testid={testId ?? "main-inbox"}
      className="h-full flex flex-col"
      style={{ background: "var(--bg)" }}
    >
      {/* TopBar — matches the Claude design's topbar height/padding */}
      <header
        className="h-14 px-4 shrink-0 flex items-center gap-3 border-b"
        style={{ borderColor: "var(--border)" }}
      >
        <div className="flex items-center gap-2">
          <InariMark size={14} />
          <span className="text-[12.5px] text-[#B5B2AB]">Inari Live</span>
          <span className="text-[#3F3F47] mx-1">·</span>
          <span className="text-[11.5px] text-[#6E6D75]" data-testid="inbox-counter">
            {rows.length} conversation{rows.length === 1 ? "" : "s"}
            {counts.firing > 0 ? ` · ${counts.firing} firing` : ""}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            data-testid="inbox-search-trigger"
            onClick={() => openPalette("search")}
            className="flex items-center gap-2 h-8 px-3 rounded-lg text-[12px] text-[#6E6D75] hover:text-[#ECE8DF] transition-colors min-w-[260px]"
            style={{
              background: "rgba(255,255,255,0.025)",
              border: "1px solid var(--border)",
            }}
          >
            <Search size={13} />
            <span>Search alerts, projects, people…</span>
            <span className="ml-auto flex items-center gap-1">
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
            </span>
          </button>
          <IconButton title="Notifications" ariaLabel="Notifications">
            <Bell size={14} />
          </IconButton>
          <IconButton title="Settings" ariaLabel="Settings">
            <Settings size={14} />
          </IconButton>
          <span className="text-[10.5px] text-[#56565e] ml-2" aria-hidden>
            <Kbd>Esc</Kbd> to chat
          </span>
        </div>
      </header>

      {/* Filter chips */}
      <div
        className="px-4 py-2.5 flex items-center gap-1.5 border-b"
        style={{ borderColor: "var(--border)" }}
      >
        <FilterChip active={filter === "all"} onClick={() => setFilter("all")} testId="inbox-filter-all">
          All <Count>{counts.all}</Count>
        </FilterChip>
        <FilterChip active={filter === "firing"} onClick={() => setFilter("firing")} testId="inbox-filter-firing">
          <Dot color="#D08585" />
          Firing <Count>{counts.firing}</Count>
        </FilterChip>
        <FilterChip active={filter === "snoozed"} onClick={() => setFilter("snoozed")} testId="inbox-filter-snoozed">
          <Dot color="#D4B47A" />
          Snoozed <Count>{counts.snoozed}</Count>
        </FilterChip>
        <FilterChip active={filter === "resolved"} onClick={() => setFilter("resolved")} testId="inbox-filter-resolved">
          <Dot color="#A6C2B0" />
          Resolved <Count>{counts.resolved}</Count>
        </FilterChip>
        <FilterChip active={filter === "mine"} onClick={() => setFilter("mine")} testId="inbox-filter-mine">
          My turn
        </FilterChip>
        <div className="ml-auto">
          <button
            type="button"
            className="flex items-center gap-1.5 text-[11px] text-[#6E6D75] hover:text-[#ECE8DF] transition-colors"
            disabled
            title="Sort options coming in V1.5"
          >
            Sort: most recent
            <ChevronDown size={10} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-auto" ref={listRef}>
        {loading && rows.length === 0 ? (
          <SkeletonList />
        ) : error ? (
          <ErrorState message={error} />
        ) : rows.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="flex flex-col" data-testid="inbox-list">
            {rows.map((row, idx) => (
              <li key={row.id}>
                <Row
                  row={row}
                  selected={idx === selectedIndex}
                  index={idx}
                  onClick={() => onSelect?.(row.id)}
                  onHover={() => setSelectedIndex(idx)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Footer */}
      <footer
        className="h-9 px-4 shrink-0 flex items-center justify-between border-t text-[11px]"
        style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
      >
        <span>
          {rows.length} of {rows.length} · {loading ? "syncing…" : "synced"}
        </span>
        <span className="font-mono text-[10.5px] text-[#56565e]" aria-hidden>
          J/K to navigate · Enter to open
        </span>
      </footer>
    </section>
  )
}

// ─── Row ────────────────────────────────────────────────────────────────────

function Row({
  row,
  selected,
  index,
  onClick,
  onHover,
}: {
  row: ConversationListRow
  selected: boolean
  index: number
  onClick: () => void
  onHover: () => void
}) {
  const sevColor = sevToColor(row.alertSeverity)
  const isFiring = row.state === "active" && row.unreadHint
  const unreadChip = row.unreadHint ? "new" : null
  const project = row.alertSourceIntegrations?.[0] ?? null
  const snippetActor = formatActor(row.lastMessageRole)
  const isUnread = row.unreadHint

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onHover}
      data-testid={`inbox-row-${row.id}`}
      data-inbox-row-index={index}
      className={`group w-full text-left px-4 py-3 border-b flex items-start gap-3 transition-colors`}
      style={{
        borderColor: "var(--border)",
        background: selected ? "rgba(255,255,255,0.025)" : "transparent",
        color: "var(--text)",
      }}
    >
      {/* severity dot */}
      <span
        aria-hidden
        className="w-[7px] h-[7px] rounded-full shrink-0 mt-1.5"
        style={{ background: sevColor }}
      />

      {/* main column */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="text-[13.5px] tracking-[-0.005em] truncate"
            style={{
              color: isUnread ? "#ECE8DF" : "#B5B2AB",
              fontWeight: isUnread ? 500 : 400,
            }}
          >
            {row.title}
          </span>
          {project ? (
            <span
              className="text-[10.5px] font-mono px-1.5 py-0.5 rounded shrink-0"
              style={{
                color: "#6E6D75",
                background: "rgba(255,255,255,0.025)",
                border: "1px solid var(--border)",
              }}
            >
              {project}
            </span>
          ) : null}
        </div>
        {row.lastMessageSnippet ? (
          <p className="text-[12px] mt-0.5 text-[#888690] line-clamp-1">
            {snippetActor ? (
              <span className="text-[#B5B2AB] font-medium mr-1">{snippetActor}:</span>
            ) : null}
            {row.lastMessageSnippet}
          </p>
        ) : null}
      </div>

      {/* status column */}
      <div className="flex flex-col items-end gap-1 shrink-0 ml-2">
        <StatusPill state={row.state} firing={isFiring} />
        {unreadChip ? (
          <span
            className="text-[10px] font-mono px-1.5 py-0.5 rounded"
            style={{
              color: "#A6C2B0",
              background: "rgba(166,194,176,0.06)",
              border: "1px solid rgba(166,194,176,0.18)",
            }}
          >
            {unreadChip}
          </span>
        ) : null}
      </div>

      {/* time + arrow */}
      <div className="flex flex-col items-end gap-1 shrink-0 ml-2">
        <span className="text-[10.5px] text-[#6E6D75] font-mono whitespace-nowrap">
          {relative(row.lastMessageAt)}
        </span>
        <ArrowRight size={13} className="text-[#56565e] group-hover:text-[#888690] transition-colors" />
      </div>
    </button>
  )
}

// ─── Status pill ────────────────────────────────────────────────────────────

function StatusPill({ state, firing }: { state: ConversationState; firing: boolean }) {
  if (state === "snoozed") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-[#D4B47A]">
        <Moon size={11} />
        snoozed
      </span>
    )
  }
  if (state === "resolved") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-[#A6C2B0]">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M5 12l5 5L20 7" />
        </svg>
        resolved
      </span>
    )
  }
  if (state === "archived") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-[#6E6D75]">
        archived
      </span>
    )
  }
  if (firing) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-[#D08585]">
        <span className="relative w-2 h-2 rounded-full bg-[#D08585]" aria-hidden>
          <span className="absolute -inset-[3px] rounded-full border-[1.5px] border-[rgba(208,133,133,0.45)] animate-[pulse_1.8s_ease-out_infinite]" />
        </span>
        firing
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-[#6E6D75]">
      <span className="text-[#4A4A53]">·</span>
      silent
    </span>
  )
}

// ─── Empty / Loading / Error ────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center" data-testid="inbox-empty">
      <div>
        <InboxIcon size={28} className="mx-auto text-[#3F3F47] mb-3" aria-hidden />
        <p className="text-[14px] text-[#ECE8DF] font-medium mb-1">No active conversations</p>
        <p className="text-[12px] text-[#888690] leading-relaxed max-w-[320px]">
          Inari is watching. Alerts that come in will create conversations here automatically.
        </p>
      </div>
    </div>
  )
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <p className="text-[12.5px] text-[#D08585]">{message}</p>
    </div>
  )
}

function SkeletonList() {
  return (
    <ul className="flex flex-col" data-testid="inbox-skeleton">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <li key={i} className="px-4 py-3 border-b flex items-start gap-3" style={{ borderColor: "var(--border)" }}>
          <span className="w-[7px] h-[7px] rounded-full bg-white/[0.05] mt-1.5" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-2/3 bg-white/[0.04] rounded animate-pulse" />
            <div className="h-2.5 w-3/4 bg-white/[0.025] rounded animate-pulse" />
          </div>
          <div className="h-2.5 w-12 bg-white/[0.025] rounded animate-pulse mt-2" />
        </li>
      ))}
    </ul>
  )
}

// ─── Bits ───────────────────────────────────────────────────────────────────

function FilterChip(props: {
  active: boolean
  onClick: () => void
  testId: string
  children: React.ReactNode
}) {
  const { active, onClick, testId, children } = props
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[11.5px] tracking-[-0.005em] transition-colors"
      style={
        active
          ? {
              background: "rgba(255,255,255,0.04)",
              color: "#ECE8DF",
              border: "1px solid rgba(255,255,255,0.085)",
            }
          : {
              background: "transparent",
              color: "#B5B2AB",
              border: "1px solid transparent",
            }
      }
    >
      {children}
    </button>
  )
}

function Count({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10.5px] text-[#6E6D75] font-mono ml-0.5">{children}</span>
  )
}

function Dot({ color }: { color: string }) {
  return <span className="w-[5px] h-[5px] rounded-full" style={{ background: color }} />
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="font-mono text-[10px] text-[#ECE8DF] px-1.5 py-0.5 rounded"
      style={{
        background: "rgba(255,255,255,0.04)",
        border: "1px solid var(--border)",
      }}
    >
      {children}
    </span>
  )
}

function IconButton(props: {
  children: React.ReactNode
  title: string
  ariaLabel: string
  onClick?: () => void
}) {
  const { children, title, ariaLabel, onClick } = props
  return (
    <button
      type="button"
      className="w-7 h-7 inline-flex items-center justify-center rounded-md text-[#888690] hover:text-[#ECE8DF] hover:bg-white/[0.04] transition-colors"
      title={title}
      aria-label={ariaLabel}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function InariMark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" className="text-[#EFE9DC]">
      <path d="M7 1.2 L12.8 7 L7 12.8 L1.2 7 Z" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="7" cy="7" r="1.9" fill="currentColor" />
    </svg>
  )
}

// ─── Pure helpers (exported for tests) ──────────────────────────────────────

export function sevToColor(sev: string | null): string {
  switch (sev) {
    case "critical": return "#D08585"
    case "warning":
    case "high":     return "#D4B47A"
    case "medium":
    case "info":     return "#B8B0E0"
    case "low":      return "#888690"
    default:         return "#56565e"
  }
}

export function formatActor(role: ConversationListRow["lastMessageRole"]): string | null {
  if (role === "assistant") return "Inari"
  if (role === "user")      return "you"
  if (role === "tool")      return "tool"
  if (role === "system")    return null
  return null
}

export function relative(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const seconds = Math.max(1, Math.round((Date.now() - then) / 1000))
  if (seconds < 60)    return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60)    return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24)      return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days === 1)      return "yesterday"
  if (days < 30)       return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}
