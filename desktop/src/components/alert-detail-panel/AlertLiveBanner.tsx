/**
 * Live banner — "Still firing · last event Xs ago" when not resolved,
 * "Resolved Xm ago · MTTR Y" when resolved. The pulse-dot animation
 * is purely CSS, no JS interval.
 */

import { CheckCircle2 } from "lucide-react"
import type { AlertDetail } from "@/lib/cloud-ipc"

export interface AlertLiveBannerProps {
  detail: AlertDetail
}

export function AlertLiveBanner({ detail }: AlertLiveBannerProps) {
  const firing = !detail.isResolved

  const lastEventLabel = firing
    ? `last event ${relativeShort(detail.lastEventAt)}`
    : detail.resolvedAt
      ? `closed at ${detail.resolvedAt.slice(11, 19)} UTC`
      : null

  const mttr =
    !firing && detail.resolvedAt
      ? mttrLabel(detail.createdAt, detail.resolvedAt)
      : null

  return (
    <div className="px-4 pt-3 pb-3 border-b border-white/[0.055]">
      <div
        className={
          firing
            ? "flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-[12.5px] bg-[rgba(208,133,133,0.05)] border-[rgba(208,133,133,0.20)] text-[#E5C0C0]"
            : "flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-[12.5px] bg-[rgba(166,194,176,0.04)] border-[rgba(166,194,176,0.18)] text-[#BFD5C7]"
        }
      >
        {firing ? <PulseDot /> : <CheckCircle2 size={14} className="text-[#A6C2B0] shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className="text-[12.5px] truncate">
            <strong className="text-[#ECE8DF] font-medium">
              {firing ? "Still firing" : "Resolved"}
            </strong>
            {firing
              ? null
              : mttr
                ? <span> · MTTR {mttr}</span>
                : null}
          </div>
          {lastEventLabel ? (
            <div className="text-[10.5px] text-[#888690] font-mono mt-0.5 truncate">{lastEventLabel}</div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function PulseDot() {
  return (
    <span
      className="relative w-2 h-2 rounded-full bg-[#D08585] shrink-0"
      aria-hidden
    >
      <span className="absolute -inset-[3px] rounded-full border-[1.5px] border-[rgba(208,133,133,0.45)] animate-[pulse_1.8s_ease-out_infinite]" />
    </span>
  )
}

// Pure helpers — exported for unit tests
export function relativeShort(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return "—"
  const diffMs = Date.now() - then
  if (diffMs < 0) return "just now"
  const s = Math.round(diffMs / 1000)
  if (s < 5) return "just now"
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

export function mttrLabel(createdIso: string, resolvedIso: string): string | null {
  const a = new Date(createdIso).getTime()
  const b = new Date(resolvedIso).getTime()
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null
  const seconds = Math.floor((b - a) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remSec = seconds % 60
  if (minutes < 60) return remSec > 0 ? `${minutes}m ${remSec}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remMin = minutes % 60
  return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`
}
