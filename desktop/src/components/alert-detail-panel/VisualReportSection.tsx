/**
 * VisualReportSection — rendered inside AlertDetailPanel when an alert's
 * source_integrations array includes 'user_report'. Shows the screenshot
 * the user attached plus the structured AI diagnosis with evidence chips.
 *
 * Pipeline status drives the render:
 *
 *   pending / triaging / diagnosing → spinner + "Inari is analysing…"
 *   completed                       → screenshot + diagnosis with chips
 *   need_info                       → screenshot + low-confidence draft +
 *                                     "More context would help" hint
 *   failed                          → error banner with retry copy
 *   rejected                        → "Inari thinks this isn't a bug"
 *
 * Re-fetches every 6s while status is in-flight (pending/triaging/
 * diagnosing/critiquing) so the panel surfaces the diagnosis as soon as
 * it lands without manual refresh.
 */

import { useEffect, useState } from "react"
import { Camera, AlertCircle, Loader2, FileCode, Lightbulb } from "lucide-react"
import { cloudGetVisualReport, type VisualReportDetail, type VisualReportEvidence } from "@/lib/cloud-ipc"

export interface VisualReportSectionProps {
  alertId: string
}

const IN_FLIGHT_STATUSES = new Set(["pending", "triaging", "diagnosing", "critiquing"])

export function VisualReportSection({ alertId }: VisualReportSectionProps) {
  const [report, setReport] = useState<VisualReportDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [zoomed, setZoomed] = useState(false)

  useEffect(() => {
    let cancelled = false

    const fetchOnce = async () => {
      try {
        const r = await cloudGetVisualReport(alertId)
        if (cancelled) return
        setReport(r)
        setError(null)
        return r
      } catch (e) {
        if (cancelled) return
        // 404 is expected for alerts that aren't visual reports — the
        // parent shouldn't have rendered us in that case, but render a
        // soft empty state rather than a scary error if it does.
        const msg = typeof e === "string" ? e : (e instanceof Error ? e.message : String(e))
        if (/404|not found/i.test(msg)) {
          setReport(null)
          setError(null)
          return null
        }
        setError(msg)
        return null
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    let pollTimer: ReturnType<typeof setTimeout> | null = null
    const stopPolling = () => {
      if (pollTimer) {
        clearTimeout(pollTimer)
        pollTimer = null
      }
    }

    void fetchOnce().then((r) => {
      // Poll every 6s while the pipeline is still running. Stops as soon as
      // status leaves the in-flight set.
      if (!r || !IN_FLIGHT_STATUSES.has(r.status)) return
      const tick = async () => {
        if (cancelled) return
        const next = await fetchOnce()
        if (next && IN_FLIGHT_STATUSES.has(next.status)) {
          pollTimer = setTimeout(tick, 6000)
        }
      }
      pollTimer = setTimeout(tick, 6000)
    })

    return () => {
      cancelled = true
      stopPolling()
    }
  }, [alertId])

  if (loading) {
    return (
      <div className="px-4 py-3 border-t border-white/[0.055] text-[11.5px] text-[#888690]">
        <Loader2 size={13} className="inline animate-spin mr-1.5" />
        Loading visual report…
      </div>
    )
  }

  if (error) {
    return (
      <div className="px-4 py-3 border-t border-white/[0.055] bg-[rgba(208,133,133,0.04)] text-[11.5px] text-[#E5C0C0]">
        <AlertCircle size={13} className="inline mr-1.5" />
        {error}
      </div>
    )
  }

  if (!report) return null

  return (
    <div className="px-4 py-3 border-t border-white/[0.055]">
      {/* Section header */}
      <div className="flex items-center gap-2 mb-3">
        <Camera size={12} className="text-[#888690]" />
        <span className="text-[10.5px] uppercase tracking-wider text-[#888690] font-medium">
          Visual report
        </span>
        <StatusPill status={report.status} confidence={report.confidence} />
      </div>

      {/* Description */}
      {report.description && (
        <div className="mb-3 text-[12.5px] text-[#D3D0CA] leading-relaxed italic">
          “{report.description}”
        </div>
      )}

      {/* Screenshot */}
      <button
        type="button"
        onClick={() => setZoomed((z) => !z)}
        className="w-full mb-3 rounded-md overflow-hidden border border-white/[0.085] bg-black/30 hover:border-white/[0.18] transition-colors cursor-zoom-in"
        title={zoomed ? "Click to shrink" : "Click to zoom"}
      >
        <img
          src={report.screenshotUrl}
          alt="User-submitted screenshot"
          className={zoomed ? "w-full" : "w-full max-h-[200px] object-cover object-top"}
        />
      </button>

      {/* Status-specific body */}
      {IN_FLIGHT_STATUSES.has(report.status) && <InFlightBody status={report.status} />}
      {report.status === "completed" && report.diagnosis && (
        <DiagnosisBody diagnosis={report.diagnosis} model={report.modelDiagnose} durationMs={report.durationMs} />
      )}
      {report.status === "need_info" && report.diagnosis && (
        <NeedInfoBody diagnosis={report.diagnosis} model={report.modelDiagnose} />
      )}
      {report.status === "failed" && (
        <div className="text-[11.5px] text-[#E5C0C0] bg-[rgba(208,133,133,0.04)] rounded px-2.5 py-2">
          <AlertCircle size={11} className="inline mr-1.5" />
          {report.error ?? "Diagnosis failed. Submit again to retry."}
        </div>
      )}
      {report.status === "rejected" && (
        <div className="text-[11.5px] text-[#888690] italic">
          Inari reviewed the report and concluded this isn't a reproducible bug.
        </div>
      )}
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────

function StatusPill({ status, confidence }: { status: string; confidence: number | null }) {
  const map: Record<string, { label: string; cls: string }> = {
    pending:     { label: "QUEUED",      cls: "bg-white/[0.06] text-[#B5B2AB]" },
    triaging:    { label: "TRIAGING",    cls: "bg-white/[0.06] text-[#B5B2AB]" },
    diagnosing:  { label: "DIAGNOSING",  cls: "bg-[rgba(124,166,213,0.12)] text-[#9CC3E8]" },
    critiquing:  { label: "CRITIQUING",  cls: "bg-[rgba(124,166,213,0.12)] text-[#9CC3E8]" },
    completed:   { label: confidence != null ? `${confidence}% CONF` : "DIAGNOSED",
                    cls: "bg-[rgba(135,178,127,0.12)] text-[#9CC799]" },
    need_info:   { label: "NEEDS INFO",  cls: "bg-[rgba(214,176,124,0.12)] text-[#D8BD8E]" },
    rejected:    { label: "REJECTED",    cls: "bg-white/[0.06] text-[#888690]" },
    failed:      { label: "FAILED",      cls: "bg-[rgba(208,133,133,0.12)] text-[#E5C0C0]" },
  }
  const entry = map[status] ?? { label: status.toUpperCase(), cls: "bg-white/[0.06] text-[#B5B2AB]" }
  return (
    <span className={`text-[9.5px] font-mono tracking-wider px-1.5 py-0.5 rounded ${entry.cls}`}>
      {entry.label}
    </span>
  )
}

function InFlightBody({ status }: { status: string }) {
  const label = status === "diagnosing"
    ? "Inari is analysing the screenshot + captured context…"
    : status === "critiquing"
      ? "Cross-checking the diagnosis…"
      : "Queued for diagnosis…"
  return (
    <div className="text-[11.5px] text-[#888690] flex items-center gap-2 py-2">
      <Loader2 size={12} className="animate-spin" />
      {label}
    </div>
  )
}

function DiagnosisBody({
  diagnosis,
  model,
  durationMs,
}: {
  diagnosis: VisualReportDetail["diagnosis"] & object
  model: string | null
  durationMs: number | null
}) {
  return (
    <div className="space-y-3">
      {/* Root cause */}
      <div>
        <div className="flex items-center gap-1.5 mb-1.5">
          <FileCode size={11} className="text-[#9CC799]" />
          <span className="text-[10.5px] uppercase tracking-wider text-[#888690] font-medium">
            Root cause
          </span>
        </div>
        {diagnosis.root_cause.file ? (
          <div className="text-[12px] font-mono text-[#9CC3E8] mb-1.5">
            {diagnosis.root_cause.file}:{diagnosis.root_cause.line}
            {diagnosis.root_cause.function && (
              <span className="text-[#888690]"> · {diagnosis.root_cause.function}()</span>
            )}
          </div>
        ) : (
          <div className="text-[11.5px] text-[#888690] italic mb-1.5">
            (root file not identified — see unknowns below)
          </div>
        )}
        {diagnosis.root_cause.causal_chain.length > 0 && (
          <ol className="text-[11.5px] text-[#D3D0CA] space-y-1 list-decimal list-inside leading-relaxed">
            {diagnosis.root_cause.causal_chain.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        )}
      </div>

      {/* Recommended fix hint */}
      {diagnosis.recommended_fix_hint && (
        <div className="text-[11.5px] bg-[rgba(135,178,127,0.04)] border border-[rgba(135,178,127,0.16)] rounded px-2.5 py-2 text-[#C4D9BA]">
          <Lightbulb size={11} className="inline mr-1.5 text-[#9CC799]" />
          <span className="font-medium">Fix hint:</span> {diagnosis.recommended_fix_hint}
        </div>
      )}

      {/* Evidence chips */}
      {diagnosis.evidence.length > 0 && (
        <div>
          <div className="text-[10.5px] uppercase tracking-wider text-[#888690] font-medium mb-1.5">
            Evidence
          </div>
          <div className="flex flex-wrap gap-1.5">
            {diagnosis.evidence.map((e, i) => (
              <EvidenceChip key={i} evidence={e} />
            ))}
          </div>
        </div>
      )}

      {/* Unknowns (if any leftover at completed confidence) */}
      {diagnosis.unknowns.length > 0 && (
        <div className="text-[11px] text-[#D8BD8E] bg-[rgba(214,176,124,0.04)] rounded px-2.5 py-2">
          <span className="font-medium">Missing context:</span>
          <ul className="list-disc list-inside mt-1 space-y-0.5">
            {diagnosis.unknowns.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Telemetry footer */}
      {(model || durationMs) && (
        <div className="text-[10px] text-[#56565e] pt-1 border-t border-white/[0.055]">
          {model && <span className="font-mono">{model}</span>}
          {model && durationMs && <span> · </span>}
          {durationMs && <span>{(durationMs / 1000).toFixed(1)}s</span>}
        </div>
      )}
    </div>
  )
}

function NeedInfoBody({
  diagnosis,
  model,
}: {
  diagnosis: VisualReportDetail["diagnosis"] & object
  model: string | null
}) {
  return (
    <div className="space-y-2.5">
      <div className="text-[11.5px] text-[#D8BD8E] bg-[rgba(214,176,124,0.04)] border border-[rgba(214,176,124,0.16)] rounded px-2.5 py-2">
        Inari has a tentative diagnosis but needs more context to be confident.
      </div>
      {diagnosis.unknowns.length > 0 && (
        <div>
          <div className="text-[10.5px] uppercase tracking-wider text-[#888690] font-medium mb-1.5">
            What would help
          </div>
          <ul className="text-[11.5px] text-[#D3D0CA] list-disc list-inside space-y-1 leading-relaxed">
            {diagnosis.unknowns.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </div>
      )}
      {diagnosis.recommended_fix_hint && (
        <div className="text-[11px] text-[#888690] italic">
          Best guess so far: {diagnosis.recommended_fix_hint}
        </div>
      )}
      {model && (
        <div className="text-[10px] text-[#56565e] font-mono">{model}</div>
      )}
    </div>
  )
}

function EvidenceChip({ evidence }: { evidence: VisualReportEvidence }) {
  const sourceColors: Record<string, string> = {
    screenshot: "bg-[rgba(216,166,124,0.10)] text-[#D8BD8E] border-[rgba(216,166,124,0.20)]",
    dom:        "bg-[rgba(124,166,213,0.10)] text-[#9CC3E8] border-[rgba(124,166,213,0.20)]",
    state:      "bg-[rgba(168,124,213,0.10)] text-[#BC9CE8] border-[rgba(168,124,213,0.20)]",
    console:    "bg-[rgba(208,133,133,0.10)] text-[#E5C0C0] border-[rgba(208,133,133,0.20)]",
    network:    "bg-[rgba(135,178,127,0.10)] text-[#9CC799] border-[rgba(135,178,127,0.20)]",
    repo:       "bg-[rgba(180,180,180,0.06)] text-[#B5B2AB] border-white/[0.085]",
    url:        "bg-white/[0.04] text-[#888690] border-white/[0.085]",
    perf:       "bg-white/[0.04] text-[#888690] border-white/[0.085]",
  }
  const cls = sourceColors[evidence.source] ?? sourceColors.repo
  return (
    <div
      className={`text-[10.5px] px-2 py-1 rounded border ${cls} cursor-help`}
      title={`${evidence.source} — ${evidence.quote}`}
    >
      <span className="font-mono uppercase tracking-wider opacity-70 mr-1">{evidence.source}</span>
      {evidence.claim}
    </div>
  )
}
