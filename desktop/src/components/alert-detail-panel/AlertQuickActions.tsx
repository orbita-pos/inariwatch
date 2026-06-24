/**
 * Quick action pills — Ack, Silence 1h, Escalate, Resolve. Different
 * action set when the alert is already resolved (postmortem mode).
 *
 * The button labelled "primary" gets the accent fill. We default-pick
 * the most useful primary per state:
 *   firing  → Ack    (most common first step)
 *   resolved → Reopen (less common but the only forward-action left)
 */

import { Check, CircleAlert, Lock, RotateCcw, Bell, CircleCheck } from "lucide-react"
import type { AlertDetail } from "@/lib/cloud-ipc"

export interface AlertQuickActionsProps {
  detail: AlertDetail
  onAck: () => void
  onSilence: () => void
  onEscalate: () => void
  onResolve: () => void
}

export function AlertQuickActions({
  detail,
  onAck,
  onSilence,
  onEscalate,
  onResolve,
}: AlertQuickActionsProps) {
  return (
    <div className="px-4 py-3 border-b border-white/[0.055]">
      <div className="text-[10px] uppercase tracking-[0.14em] text-[#6E6D75] mb-2 font-mono">
        {detail.isResolved ? "Postmortem actions" : "Quick actions"}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {detail.isResolved ? (
          <PostmortemActions onReopen={onAck} />
        ) : (
          <FiringActions
            isAcked={detail.isRead}
            onAck={onAck}
            onSilence={onSilence}
            onEscalate={onEscalate}
            onResolve={onResolve}
          />
        )}
      </div>
    </div>
  )
}

function FiringActions(props: {
  isAcked: boolean
  onAck: () => void
  onSilence: () => void
  onEscalate: () => void
  onResolve: () => void
}) {
  const { isAcked, onAck, onSilence, onEscalate, onResolve } = props
  return (
    <>
      <Pill
        onClick={onAck}
        primary={!isAcked}
        icon={<Check size={11} />}
        label={isAcked ? "Acked" : "Ack"}
        disabled={isAcked}
        title={isAcked ? "Already acknowledged" : "Acknowledge this alert"}
      />
      <Pill
        onClick={onSilence}
        icon={<Lock size={11} />}
        label="Silence 1h"
        title="Silence this alert for 1 hour"
      />
      <Pill
        onClick={onEscalate}
        icon={<Bell size={11} />}
        label="Escalate"
        title="Page the on-call (V1.5)"
      />
      <Pill
        onClick={onResolve}
        icon={<CircleCheck size={11} />}
        label="Resolve"
        title="Mark this alert resolved"
      />
    </>
  )
}

function PostmortemActions({ onReopen }: { onReopen: () => void }) {
  // For MVP, reopen reuses the same `onAck` slot from the parent —
  // the parent passes a stub for now. Wire to the real reopen IPC in
  // Phase 2.
  return (
    <>
      <Pill
        primary
        onClick={onReopen}
        icon={<RotateCcw size={11} />}
        label="Reopen"
        title="Reopen this alert"
      />
      <Pill
        onClick={() => {/* generate report — Phase 2 */}}
        icon={<CircleAlert size={11} />}
        label="Generate report"
        title="Generate post-mortem (V1.5)"
      />
    </>
  )
}

function Pill(props: {
  onClick: () => void
  icon: React.ReactNode
  label: string
  primary?: boolean
  disabled?: boolean
  title?: string
}) {
  const { onClick, icon, label, primary, disabled, title } = props
  const baseClass =
    "inline-flex items-center gap-1.5 h-[26px] px-[9px] rounded-[7px] text-[11.5px] tracking-[-0.005em] border transition-colors"
  const variantClass = primary
    ? "bg-[#EFE9DC] text-[#16161a] border-black/[0.18] shadow-[inset_0_1px_0_rgba(255,255,255,0.55),0_1px_0_rgba(0,0,0,0.45)] hover:bg-[#E5DCC7]"
    : "bg-transparent text-[#B5B2AB] border-white/[0.085] hover:border-white/[0.12] hover:text-[#ECE8DF] hover:bg-white/[0.015]"
  const disabledClass = disabled ? "opacity-40 cursor-not-allowed hover:bg-transparent hover:border-white/[0.085] hover:text-[#B5B2AB]" : ""
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${baseClass} ${variantClass} ${disabledClass}`}
    >
      <span className="opacity-85 shrink-0">{icon}</span>
      {label}
    </button>
  )
}
