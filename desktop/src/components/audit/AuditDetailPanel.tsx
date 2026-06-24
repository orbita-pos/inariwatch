import { ArrowRight, Check, ChevronDown, ChevronRight, KeyRound } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import {
  desktopAuditGet,
  type AuditEntry,
} from "@/lib/audit-ui-ipc";

/**
 * Detail panel — right 40% of the audit archive surface.
 *
 * Per the 2026-05-07 design comp (Frame A1):
 *
 *   - Sticky header: eyebrow `Selected · w_xxxx`, tool name (mono),
 *     status pill + timestamp + duration line.
 *   - Body sections, scroll-friendly:
 *       Summary kv (duration / permission / runner / caller)
 *       Args        — collapsible JSON card
 *       Output      — collapsible JSON card
 *       Witness     — sage chip + "all 4 checks passed" + "Open verifier modal →"
 *
 * No selection? Quiet centered empty state with a key icon.
 */
export interface AuditDetailPanelProps {
  selectedId: string | null;
  onClose: () => void;
  onVerify: (id: string, receiptId: string | null) => void;
  className?: string;
  testId?: string;
}

export function AuditDetailPanel({
  selectedId,
  onClose: _onClose,
  onVerify,
  className,
  testId,
}: AuditDetailPanelProps) {
  const [entry, setEntry] = useState<AuditEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!selectedId) {
      setEntry(null);
      setError(null);
      return;
    }
    setError(null);
    desktopAuditGet(selectedId)
      .then((row) => {
        if (!cancelled) setEntry(row);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(typeof e === "string" ? e : (e as Error).message ?? "unknown");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  if (!selectedId) {
    return <EmptyState testId={testId} className={className} />;
  }

  if (error) {
    return (
      <div
        data-testid={testId ?? "audit-detail-panel"}
        className={["flex-1 min-w-0 overflow-auto", className]
          .filter(Boolean)
          .join(" ")}
        style={{ width: "40%", minWidth: 0 }}
      >
        <div
          className="m-5 p-3 rounded-[8px] text-[12px]"
          style={{ border: "1px solid var(--danger)", color: "var(--danger)" }}
        >
          Failed to load: {error}
        </div>
      </div>
    );
  }

  if (!entry) {
    return (
      <div
        data-testid={testId ?? "audit-detail-panel"}
        className={["flex-1 min-w-0", className].filter(Boolean).join(" ")}
        style={{ width: "40%", minWidth: 0 }}
      >
        <div
          className="m-5 text-[12.5px]"
          style={{ color: "var(--text-subtle)" }}
        >
          Loading…
        </div>
      </div>
    );
  }

  const status = deriveStatus(entry);
  const duration = entry.finished_at_ms - entry.started_at_ms;
  const witnessShort = deriveWitnessShort(entry.id);

  return (
    <div
      data-testid={testId ?? "audit-detail-panel"}
      className={["flex flex-col min-h-0", className].filter(Boolean).join(" ")}
      style={{ width: "40%", minWidth: 0 }}
    >
      {/* Sticky header */}
      <div
        className="px-5 pt-4 pb-3 shrink-0"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <Eyebrow tone="sage">
          Selected ·{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>{witnessShort}</span>
        </Eyebrow>
        <div
          className="text-[15px] mt-1.5 truncate"
          style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}
        >
          {entry.tool_name}
        </div>
        <div className="flex items-center gap-2 mt-2.5 flex-wrap">
          <StatusPill status={status} />
          <span style={{ color: "var(--text-faint)" }}>·</span>
          <span className="text-[11.5px]" style={{ color: "var(--text-dim)" }}>
            {new Date(entry.started_at_ms).toISOString().slice(11, 19)} UTC
          </span>
          {duration > 0 ? (
            <>
              <span style={{ color: "var(--text-faint)" }}>·</span>
              <span
                className="text-[11.5px]"
                style={{ fontFamily: "var(--font-mono)", color: "var(--text-dim)" }}
              >
                {formatDuration(duration)}
              </span>
            </>
          ) : null}
        </div>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 min-h-0 overflow-auto px-5 py-4 space-y-5">
        <SummarySection entry={entry} duration={duration} />
        <CollapsibleJson title="Args" json={entry.args_json} initiallyOpen />
        <CollapsibleJson title="Output" json={entry.result_json} />

        {/* Witness footer */}
        <div>
          <Eyebrow>Witness receipt</Eyebrow>
          <div className="flex items-center gap-2.5 mt-2 flex-wrap">
            <span
              className="inline-flex items-center gap-1.5"
              style={{
                height: 22,
                padding: "0 8px 0 7px",
                borderRadius: 999,
                background:
                  "linear-gradient(180deg, rgba(166,194,176,0.07), rgba(166,194,176,0.03))",
                border: "1px solid rgba(166,194,176,0.18)",
                color: "var(--verified)",
                fontSize: 11,
                lineHeight: 1,
              }}
            >
              <KeyRound size={11} strokeWidth={1.6} />
              <span style={{ color: "rgba(166,194,176,0.78)" }}>verified</span>
              <span style={{ color: "rgba(166,194,176,0.35)" }}>·</span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  color: "#C8DDD0",
                  letterSpacing: "0.01em",
                }}
              >
                {witnessShort}
              </span>
            </span>
            <span className="text-[12px]" style={{ color: "var(--text-dim)" }}>
              {entry.witness_receipt_id
                ? "all 4 checks passed"
                : "not chained yet"}
            </span>
          </div>
          <button
            type="button"
            data-testid="audit-detail-open-verifier"
            onClick={() => onVerify(entry.id, entry.witness_receipt_id)}
            className="inline-flex items-center gap-2 mt-3 transition-colors hover:bg-white/[0.025]"
            style={{
              height: 32,
              padding: "0 12px",
              borderRadius: 8,
              background: "transparent",
              border: "1px solid var(--border-strong)",
              color: "var(--text-muted)",
              fontSize: 12,
            }}
          >
            <KeyRound size={11} strokeWidth={1.6} style={{ color: "var(--verified)" }} />
            <span>Open verifier modal</span>
            <ArrowRight size={11} strokeWidth={1.8} style={{ color: "var(--text-faint)" }} />
          </button>
        </div>
      </div>
    </div>
  );
}

interface EmptyStateProps {
  testId?: string;
  className?: string;
}

function EmptyState({ testId, className }: EmptyStateProps) {
  return (
    <div
      data-testid={testId ?? "audit-detail-panel"}
      className={["flex items-center justify-center", className]
        .filter(Boolean)
        .join(" ")}
      style={{ width: "40%", minWidth: 0 }}
    >
      <div className="flex flex-col items-center gap-3.5 text-center px-6">
        <div
          className="flex items-center justify-center"
          style={{
            width: 38,
            height: 38,
            borderRadius: 10,
            border: "1px solid var(--border)",
            color: "var(--text-faint)",
          }}
        >
          <KeyRound size={16} strokeWidth={1.6} />
        </div>
        <div
          className="text-[12.5px] leading-[1.55]"
          style={{ color: "var(--text-subtle)", maxWidth: 240 }}
        >
          Pick an invocation to inspect its receipt.
        </div>
      </div>
    </div>
  );
}

interface SummarySectionProps {
  entry: AuditEntry;
  duration: number;
}

function SummarySection({ entry, duration }: SummarySectionProps) {
  return (
    <div>
      <Eyebrow>Summary</Eyebrow>
      <div className="mt-2 space-y-1">
        <KvRow k="duration" v={formatDuration(duration)} mono />
        <KvRow
          k="permission"
          v={
            <>
              <span style={{ color: "var(--text)" }}>{entry.permission}</span>
              {entry.permission_decision !== "allow" ? (
                <>
                  <span style={{ color: "var(--text-faint)" }}> · </span>
                  <span style={{ color: "var(--text-muted)" }}>
                    decision {entry.permission_decision}
                  </span>
                </>
              ) : null}
            </>
          }
        />
        {entry.session_id ? (
          <KvRow
            k="caller"
            v={
              <span style={{ fontFamily: "var(--font-mono)" }}>
                sess {entry.session_id.slice(0, 8)}
              </span>
            }
          />
        ) : null}
        <KvRow
          k="runner"
          v={
            <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
              this workstation
            </span>
          }
        />
      </div>
    </div>
  );
}

interface KvRowProps {
  k: string;
  v: ReactNode;
  mono?: boolean;
}

function KvRow({ k, v, mono = false }: KvRowProps) {
  return (
    <div
      className="grid items-baseline"
      style={{ gridTemplateColumns: "104px 1fr", gap: 12 }}
    >
      <span className="text-[11.5px]" style={{ color: "var(--text-dim)" }}>
        {k}
      </span>
      <span
        className="text-[12.5px]"
        style={{
          fontFamily: mono ? "var(--font-mono)" : undefined,
          color: "var(--text)",
        }}
      >
        {v}
      </span>
    </div>
  );
}

interface CollapsibleJsonProps {
  title: string;
  json: string | null;
  initiallyOpen?: boolean;
}

function CollapsibleJson({ title, json, initiallyOpen = false }: CollapsibleJsonProps) {
  const [open, setOpen] = useState(initiallyOpen);
  const summary = json ? summarize(json) : "—";
  const bytes = json ? new Blob([json]).size : 0;

  return (
    <div>
      <Eyebrow>{title}</Eyebrow>
      <div
        className="mt-2 rounded-[10px] overflow-hidden"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
        }}
      >
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-center justify-between px-3 py-2 text-left transition-colors hover:bg-white/[0.012]"
          aria-expanded={open}
        >
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {open ? (
              <ChevronDown size={11} strokeWidth={2} style={{ color: "var(--text-dim)" }} />
            ) : (
              <ChevronRight size={11} strokeWidth={2} style={{ color: "var(--text-dim)" }} />
            )}
            <span
              className="text-[12px] truncate"
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--text-muted)",
              }}
            >
              {summary}
            </span>
          </div>
          <span
            className="text-[10.5px] shrink-0 ml-2"
            style={{ fontFamily: "var(--font-mono)", color: "var(--text-faint)" }}
          >
            {bytes ? `${bytes}B` : ""}
          </span>
        </button>
        {open && json ? (
          <pre
            className="m-0 px-3 py-2.5 overflow-auto text-[11.5px] max-h-[180px]"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--text-muted)",
              background: "rgba(0,0,0,0.18)",
              borderTop: "1px solid var(--border)",
            }}
          >
            {pretty(json)}
          </pre>
        ) : null}
      </div>
    </div>
  );
}

interface StatusPillProps {
  status: "done" | "failed" | "denied" | "pending";
}

function StatusPill({ status }: StatusPillProps) {
  const config = {
    done: {
      bg: "rgba(166,194,176,0.06)",
      border: "rgba(166,194,176,0.18)",
      color: "#BFD5C7",
      icon: <Check size={9} strokeWidth={3} />,
    },
    failed: {
      bg: "rgba(208,133,133,0.07)",
      border: "rgba(208,133,133,0.22)",
      color: "#E0A8A8",
      icon: null,
    },
    denied: {
      bg: "rgba(208,133,133,0.07)",
      border: "rgba(208,133,133,0.22)",
      color: "#E0A8A8",
      icon: null,
    },
    pending: {
      bg: "rgba(212,180,122,0.07)",
      border: "rgba(212,180,122,0.20)",
      color: "#E2C58B",
      icon: null,
    },
  }[status];
  return (
    <span
      className="inline-flex items-center gap-1.5"
      style={{
        height: 22,
        padding: "0 9px 0 8px",
        borderRadius: 999,
        background: config.bg,
        border: `1px solid ${config.border}`,
        color: config.color,
        fontSize: 11,
        lineHeight: 1,
      }}
    >
      {config.icon}
      {status}
    </span>
  );
}

function Eyebrow({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "sage";
}) {
  return (
    <div
      className="text-[10.5px] font-medium"
      style={{
        color: tone === "sage" ? "var(--verified)" : "var(--text-faint)",
        letterSpacing: "0.16em",
        textTransform: "uppercase",
      }}
    >
      {children}
    </div>
  );
}

function deriveStatus(
  entry: AuditEntry,
): "done" | "failed" | "denied" | "pending" {
  if (entry.permission_decision === "denied") return "denied";
  if (!entry.success) return "failed";
  return "done";
}

function deriveWitnessShort(id: string): string {
  const stripped = id.replace(/[^a-z0-9]/gi, "").slice(0, 7).toLowerCase();
  return `w_${stripped}`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(3)}s`;
}

function summarize(raw: string): string {
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? "" : "s"}]`;
    if (typeof v === "object" && v !== null) {
      const keys = Object.keys(v).slice(0, 3);
      const preview = keys
        .map(
          (k) =>
            `${k}: ${
              typeof (v as Record<string, unknown>)[k] === "object"
                ? "{…}"
                : "…"
            }`,
        )
        .join(", ");
      return `{ ${preview}${Object.keys(v).length > 3 ? ", …" : ""} }`;
    }
    return String(v);
  } catch {
    return raw.length > 80 ? `${raw.slice(0, 77)}…` : raw;
  }
}

function pretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
