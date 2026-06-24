/**
 * Timeline section — chronological feed of events for the anchored
 * alert. Renders the union of: alert birth, comments, remediation
 * sessions (started/PR opened/merged/completed/failed), and audit
 * state transitions (ack/silence/resolve/reopen/escalate).
 *
 * Server sends events in ascending order; we reverse for display so
 * newest is on top — the design's pattern in State B.
 *
 * Each event renders with an icon, primary text, optional witness
 * receipt link (mono `w_xxxx`), and a right-aligned relative
 * timestamp. The list is scrollable; the section is flex-1 inside
 * the parent panel so it eats the remaining vertical space.
 */

import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Github,
  Lock,
  MessageSquare,
  RotateCcw,
  Sparkles,
  Unlock,
  XCircle,
} from "lucide-react"
import type { AlertTimeline, TimelineEvent, TimelineEventKind } from "@/lib/cloud-ipc"
import { relativeShort } from "./AlertLiveBanner"

export interface AlertTimelineListProps {
  timeline: AlertTimeline | null
  loading: boolean
}

export function AlertTimelineList({ timeline, loading }: AlertTimelineListProps) {
  return (
    <div className="flex-1 overflow-y-auto px-4 py-3">
      <div className="text-[10px] uppercase tracking-[0.14em] text-[#6E6D75] mb-2 font-mono">
        Timeline
      </div>
      {loading && !timeline ? (
        <TimelineSkeleton />
      ) : !timeline || timeline.events.length === 0 ? (
        <div className="text-[12px] text-[#56565e] italic py-4">No timeline events yet.</div>
      ) : (
        <div className="divide-y divide-white/[0.055]">
          {[...timeline.events].reverse().map((ev) => (
            <TimelineRow key={ev.id} event={ev} />
          ))}
        </div>
      )}
    </div>
  )
}

function TimelineRow({ event }: { event: TimelineEvent }) {
  const { icon, accentClass } = iconFor(event.kind)
  return (
    <div className="grid grid-cols-[18px_1fr_auto] gap-[9px] items-start py-2 text-[12.5px]">
      <div className={`w-[18px] h-[18px] flex items-center justify-center mt-[1px] ${accentClass}`} aria-hidden>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-[#B5B2AB] leading-[1.45]">
          {event.actor && event.actor !== "system" ? (
            <strong className="text-[#ECE8DF] font-medium">{event.actor}</strong>
          ) : null}
          {event.actor && event.actor !== "system" ? " " : ""}
          <span>{event.text}</span>
        </div>
        {event.witness ? (
          <a
            className="inline-flex items-center gap-1.5 text-[#A6C2B0] text-[11px] font-mono mt-1 hover:text-[#C8DDD0] transition-colors"
            href={`https://app.inariwatch.com/witness/${event.witness}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Sparkles size={10} />
            {event.witness}
          </a>
        ) : null}
      </div>
      <div className="text-[10.5px] text-[#6E6D75] font-mono whitespace-nowrap mt-[3px]">
        {relativeShort(event.at)}
      </div>
    </div>
  )
}

function iconFor(kind: TimelineEventKind): { icon: React.ReactNode; accentClass: string } {
  switch (kind) {
    case "alert_fired":
      return { icon: <AlertTriangle size={14} />, accentClass: "text-[#D4B47A]" }
    case "comment":
      return { icon: <MessageSquare size={14} />, accentClass: "text-[#888690]" }
    case "remediation_started":
    case "remediation_pr_opened":
    case "remediation_completed":
      return { icon: <Sparkles size={14} />, accentClass: "text-[#A6C2B0]" }
    case "remediation_merged":
      return { icon: <Github size={14} />, accentClass: "text-[#888690]" }
    case "remediation_failed":
      return { icon: <XCircle size={14} />, accentClass: "text-[#D08585]" }
    case "ack":
      return { icon: <CheckCircle2 size={14} />, accentClass: "text-[#A6C2B0]" }
    case "silence":
      return { icon: <Lock size={14} />, accentClass: "text-[#888690]" }
    case "resolve":
      return { icon: <CheckCircle2 size={14} />, accentClass: "text-[#A6C2B0]" }
    case "reopen":
      return { icon: <RotateCcw size={14} />, accentClass: "text-[#D4B47A]" }
    case "escalate":
      return { icon: <Bell size={14} />, accentClass: "text-[#D4B47A]" }
    default:
      return { icon: <Unlock size={14} />, accentClass: "text-[#888690]" }
  }
}

function TimelineSkeleton() {
  return (
    <div className="space-y-2 mt-1">
      {[0, 1, 2].map((i) => (
        <div key={i} className="grid grid-cols-[18px_1fr_auto] gap-[9px] py-2">
          <div className="w-[18px] h-[18px] rounded-full bg-white/[0.025] animate-pulse" />
          <div>
            <div className="h-3 w-3/4 bg-white/[0.025] rounded animate-pulse mb-1" />
            <div className="h-2.5 w-1/3 bg-white/[0.025] rounded animate-pulse" />
          </div>
          <div className="w-12 h-2.5 bg-white/[0.025] rounded animate-pulse mt-[3px]" />
        </div>
      ))}
    </div>
  )
}
