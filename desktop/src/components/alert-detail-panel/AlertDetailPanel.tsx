/**
 * AlertDetailPanel — 360px sidecar that slides in via `Cmd+\`.
 *
 * Renders contextual info for the alert anchored to the current
 * conversation: header (severity + title + source), live banner
 * (firing/resolved), quick actions (ack/silence/escalate/resolve),
 * and a unified timeline. Mirrors the Claude-designed reference in
 * `~/Downloads/Inari Live - Detail Panel.html` (states A/B/C).
 *
 * MVP scope (deliberate omissions, see docs/decisions for ADRs):
 *   - sparkline trend       → needs alertHourlyCounts join, Phase 2
 *   - related fingerprints  → needs same-fingerprint scan, Phase 2
 *   - team presence         → needs realtime presence infra, Phase 2
 *
 * The panel is an OVERLAY (does not push chat content). The chat
 * surface stays focal; the right 360px gets covered by the panel
 * when open. Scrim edge gradient bridges the visual seam.
 *
 * Lifecycle:
 *   - Mount: fetch detail + timeline in parallel for `alertId`.
 *   - `alertId` change: refetch both.
 *   - Quick action click: optimistic local update + IPC + refetch
 *     timeline (so the new state-change event lands).
 *   - Errors: show inline retry banner in the affected section, NEVER
 *     close the panel — the user invoked it for a reason.
 *
 * Keyboard:
 *   - `Esc` → close (handled by parent — this component doesn't own focus)
 *   - `Cmd+\` toggle is handled in the parent / global keyboard layer.
 */

import { useCallback, useEffect, useState } from "react"
import { X } from "lucide-react"
import {
  cloudAckAlert,
  cloudGetAlertDetail,
  cloudGetAlertTimeline,
  cloudResolveAlert,
  cloudSilenceAlert,
  type AlertDetail,
  type AlertTimeline,
} from "@/lib/cloud-ipc"
import { AlertDetailHeader } from "./AlertDetailHeader"
import { AlertLiveBanner } from "./AlertLiveBanner"
import { AlertQuickActions } from "./AlertQuickActions"
import { AlertTimelineList } from "./AlertTimelineList"
import { VisualReportSection } from "./VisualReportSection"

export interface AlertDetailPanelProps {
  /** Alert anchored to the active conversation. null = no anchor. */
  alertId: string | null
  /** Parent fires this when the user clicks the close X or hits Esc. */
  onClose: () => void
}

export function AlertDetailPanel({ alertId, onClose }: AlertDetailPanelProps) {
  const [detail, setDetail] = useState<AlertDetail | null>(null)
  const [timeline, setTimeline] = useState<AlertTimeline | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [loadingTimeline, setLoadingTimeline] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── Fetch on alertId change ────────────────────────────────────────────
  const refetch = useCallback(async () => {
    if (!alertId) {
      setDetail(null)
      setTimeline(null)
      return
    }
    setLoadingDetail(true)
    setLoadingTimeline(true)
    setError(null)
    try {
      const [d, t] = await Promise.all([
        cloudGetAlertDetail(alertId).catch((e) => {
          setError(typeof e === "string" ? e : String(e))
          return null
        }),
        cloudGetAlertTimeline(alertId).catch(() => null),
      ])
      setDetail(d)
      setTimeline(t)
    } finally {
      setLoadingDetail(false)
      setLoadingTimeline(false)
    }
  }, [alertId])

  useEffect(() => {
    void refetch()
  }, [refetch])

  // ── Quick actions — optimistic + refetch timeline on success ──────────
  const handleAck = useCallback(async () => {
    if (!alertId) return
    try {
      await cloudAckAlert(alertId)
      // Optimistic: mark as read locally; full state lands via refetch
      setDetail((d) => (d ? { ...d, isRead: true } : d))
      const t = await cloudGetAlertTimeline(alertId).catch(() => null)
      if (t) setTimeline(t)
    } catch (e) {
      setError(typeof e === "string" ? e : String(e))
    }
  }, [alertId])

  const handleSilence = useCallback(async () => {
    if (!alertId) return
    try {
      await cloudSilenceAlert(alertId)
      setDetail((d) => (d ? { ...d, isResolved: true, resolvedAt: new Date().toISOString() } : d))
      const t = await cloudGetAlertTimeline(alertId).catch(() => null)
      if (t) setTimeline(t)
    } catch (e) {
      setError(typeof e === "string" ? e : String(e))
    }
  }, [alertId])

  const handleResolve = useCallback(async () => {
    if (!alertId) return
    try {
      await cloudResolveAlert({ alertId })
      setDetail((d) => (d ? { ...d, isResolved: true, resolvedAt: new Date().toISOString() } : d))
      const t = await cloudGetAlertTimeline(alertId).catch(() => null)
      if (t) setTimeline(t)
    } catch (e) {
      setError(typeof e === "string" ? e : String(e))
    }
  }, [alertId])

  // Escalate is a stub for MVP — surfaces "coming soon" rather than
  // wiring a noop IPC. Real implementation lands in Phase 2 alongside
  // the on-call engine bridge (see project_inari_v1_s1_s2_shipped.md).
  const handleEscalate = useCallback(() => {
    setError("Escalate ships with the on-call bridge in V1.5.")
  }, [])

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <aside
      // top-14 (56px) matches the parent TopBar height. The panel slots
      // below the chrome and runs to the bottom edge; positioned
      // absolutely so opening it does NOT shift chat content — it
      // overlays the right 360px of the conversation.
      className="absolute right-0 top-14 bottom-0 w-[360px] z-[20] flex flex-col bg-[#0c0c10] border-l border-white/[0.085] shadow-[-12px_0_32px_-10px_rgba(0,0,0,0.45)]"
      role="complementary"
      aria-label="Alert detail panel"
    >
      {/* No-anchor state — panel is open but no conversation is selected */}
      {!alertId ? (
        <div className="flex-1 flex flex-col items-center justify-center px-8 text-center">
          <div className="text-[12.5px] text-[#888690] leading-relaxed">
            Open a conversation to see its alert detail here.
          </div>
          <button
            type="button"
            onClick={onClose}
            className="mt-4 text-[11px] text-[#6E6D75] hover:text-[#ECE8DF] transition-colors"
          >
            Close panel
            <span className="ml-1.5 inline-block font-mono text-[10.5px] text-[#ECE8DF] bg-white/[0.04] border border-white/[0.085] rounded px-1.5 py-0.5">⌘\</span>
          </button>
        </div>
      ) : (
        <>
          <AlertDetailHeader
            detail={detail}
            loading={loadingDetail}
            onClose={onClose}
          />
          {detail && <AlertLiveBanner detail={detail} />}
          {detail && (
            <AlertQuickActions
              detail={detail}
              onAck={handleAck}
              onSilence={handleSilence}
              onEscalate={handleEscalate}
              onResolve={handleResolve}
            />
          )}
          {detail?.sourceIntegrations.includes("user_report") && alertId && (
            <VisualReportSection alertId={alertId} />
          )}
          <AlertTimelineList
            timeline={timeline}
            loading={loadingTimeline}
          />
          {error && (
            <div className="px-4 py-2.5 border-t border-white/[0.055] bg-[rgba(208,133,133,0.04)] text-[11.5px] text-[#E5C0C0]">
              {error}
              <button
                type="button"
                onClick={() => setError(null)}
                className="ml-2 text-[10.5px] underline opacity-70 hover:opacity-100"
              >
                dismiss
              </button>
            </div>
          )}
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-white/[0.055] bg-white/[0.005] text-[11.5px]">
            <button
              type="button"
              className="text-[#B5B2AB] hover:text-[#ECE8DF] flex items-center gap-1.5"
              onClick={() => {
                // Open the public alert page. We don't navigate inside the
                // desktop — the dashboard has the rich timeline / postmortem
                // tooling and Tauri's webview isn't the right place to
                // render it.
                if (!detail) return
                const baseUrl = "https://app.inariwatch.com"
                window.open(`${baseUrl}/alerts/${detail.id}`, "_blank", "noopener,noreferrer")
              }}
            >
              View full alert page
              <span aria-hidden>→</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-[#56565e] hover:text-[#ECE8DF] transition-colors"
              aria-label="Close panel"
              title="Close (⌘\)"
            >
              <X size={13} />
            </button>
          </div>
        </>
      )}
    </aside>
  )
}
