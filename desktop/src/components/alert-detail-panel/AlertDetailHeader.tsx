/**
 * Header section of the AlertDetailPanel — severity badge, title,
 * source integration, project context. Mirrors the design's State B
 * top section (`sev sev-crit` + flask icon + h2 + meta row).
 */

import { LifeBuoy, MoreHorizontal, X } from "lucide-react"
import type { AlertDetail } from "@/lib/cloud-ipc"

const SEV_CLASS: Record<string, { color: string; bg: string; border: string; dot: string }> = {
  critical: {
    color:  "text-[#D08585]",
    bg:     "bg-[rgba(208,133,133,0.06)]",
    border: "border-[rgba(208,133,133,0.32)]",
    dot:    "bg-[#D08585]",
  },
  warning: {
    color:  "text-[#D4B47A]",
    bg:     "bg-[rgba(212,180,122,0.06)]",
    border: "border-[rgba(212,180,122,0.32)]",
    dot:    "bg-[#D4B47A]",
  },
  high: {
    color:  "text-[#D4B47A]",
    bg:     "bg-[rgba(212,180,122,0.06)]",
    border: "border-[rgba(212,180,122,0.32)]",
    dot:    "bg-[#D4B47A]",
  },
  medium: {
    color:  "text-[#B8B0E0]",
    bg:     "bg-[rgba(184,176,224,0.06)]",
    border: "border-[rgba(184,176,224,0.32)]",
    dot:    "bg-[#B8B0E0]",
  },
  info: {
    color:  "text-[#B8B0E0]",
    bg:     "bg-[rgba(184,176,224,0.06)]",
    border: "border-[rgba(184,176,224,0.32)]",
    dot:    "bg-[#B8B0E0]",
  },
  low: {
    color:  "text-[#888690]",
    bg:     "bg-white/[0.02]",
    border: "border-white/[0.12]",
    dot:    "bg-[#888690]",
  },
}

export interface AlertDetailHeaderProps {
  detail: AlertDetail | null
  loading: boolean
  onClose: () => void
}

export function AlertDetailHeader({ detail, loading, onClose }: AlertDetailHeaderProps) {
  if (loading && !detail) {
    return (
      <div className="px-4 py-3.5 border-b border-white/[0.055]">
        <div className="h-5 w-20 bg-white/[0.025] rounded animate-pulse mb-3" />
        <div className="h-5 w-3/4 bg-white/[0.025] rounded animate-pulse mb-2" />
        <div className="h-3 w-1/2 bg-white/[0.025] rounded animate-pulse" />
      </div>
    )
  }
  if (!detail) {
    return null
  }

  const sevKey = detail.severity.toLowerCase()
  const sev = SEV_CLASS[sevKey] ?? SEV_CLASS.low
  const sevLabel = sevKey.charAt(0).toUpperCase() + sevKey.slice(1)
  const sourceLabel = detail.sourceIntegrations[0] ?? "manual"

  return (
    <div className="px-4 py-3.5 border-b border-white/[0.055]">
      <div className="flex items-center justify-between mb-3">
        <span
          className={`inline-flex items-center gap-1.5 h-5 px-2 rounded-full text-[10.5px] uppercase tracking-[0.06em] border font-mono ${sev.color} ${sev.bg} ${sev.border}`}
        >
          <span className={`w-[5px] h-[5px] rounded-full ${sev.dot}`} />
          {sevLabel}
        </span>
        <div className="flex items-center gap-1">
          <button
            className="w-6 h-6 inline-flex items-center justify-center text-[#888690] hover:text-[#ECE8DF] rounded transition-colors"
            title="More"
            type="button"
          >
            <MoreHorizontal size={14} />
          </button>
          <button
            className="w-6 h-6 inline-flex items-center justify-center text-[#888690] hover:text-[#ECE8DF] rounded transition-colors"
            title="Close (⌘\)"
            type="button"
            onClick={onClose}
            aria-label="Close panel"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="flex items-start gap-2 mb-2">
        <span className="text-[#B5B2AB] mt-0.5 shrink-0">
          <LifeBuoy size={14} />
        </span>
        <h2 className="text-[14.5px] text-[#ECE8DF] leading-[1.4] font-medium tracking-[-0.005em] flex-1 break-words">
          {detail.title}
        </h2>
      </div>

      <div className="flex items-center gap-2 text-[11px] text-[#6E6D75]">
        <span className="capitalize">{sourceLabel}</span>
        <span className="text-[#3F3F47]">·</span>
        <span>{detail.projectName}</span>
        {detail.fingerprint ? (
          <>
            <span className="text-[#3F3F47]">·</span>
            <span className="font-mono">{detail.fingerprint.slice(0, 8)}</span>
          </>
        ) : null}
      </div>
    </div>
  )
}
