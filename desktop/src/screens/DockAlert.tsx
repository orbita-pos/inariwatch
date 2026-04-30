import { motion, useReducedMotion } from "framer-motion";
import {
  AlertTriangle,
  ExternalLink,
  FileCode,
  GitBranch,
  Pencil,
  Rocket,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  type ComponentType,
} from "react";

import { ConfidenceBadge } from "@/components/ConfidenceBadge";
import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  applyFix,
  hideDock,
  openInEditor,
  type ApplyFixResult,
} from "@/lib/dock-ipc";
import { useChat } from "@/lib/store/chat";
import type { Alert, Severity } from "@/types/alert";

interface DockAlertProps {
  /** Test override; production reads from `useChat.currentAlert`. */
  alertOverride?: Alert | null;
}

interface SeverityVisuals {
  Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  toneClass: string;
  label: string;
}

const SEVERITY_VISUALS: Record<Severity, SeverityVisuals> = {
  critical: {
    Icon: ShieldAlert,
    toneClass: "text-[var(--color-danger)]",
    label: "critical",
  },
  high: {
    Icon: AlertTriangle,
    toneClass: "text-[var(--color-danger)]",
    label: "high",
  },
  medium: {
    Icon: AlertTriangle,
    toneClass: "text-[var(--color-warning)]",
    label: "medium",
  },
  low: {
    Icon: ShieldCheck,
    toneClass: "text-[var(--color-success)]",
    label: "low",
  },
};

function relativeTime(ms: number): string {
  const delta = Math.max(0, Date.now() - ms);
  const m = Math.floor(delta / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function absoluteTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

interface ApplyState {
  status: "idle" | "running" | "success" | "fail";
  message?: string;
}

/**
 * Dock Mode 3 — alert triage. Three sections (header / body / footer).
 * The body scrolls; header + footer are sticky. The "Apply & deploy"
 * button morphs in-place to a progress bar → checkmark / cross — there
 * is NO modal overlay (per Sesión 16 spec).
 *
 * Production reads the alert from `useChat.currentAlert`. Tests inject
 * via the `alertOverride` prop or pre-populate the store with
 * `useChat.openAlert(...)`.
 */
export function DockAlert({ alertOverride = null }: DockAlertProps) {
  const storeAlert = useChat((s) => s.currentAlert);
  const openDiff = useChat((s) => s.openDiff);
  const reduce = useReducedMotion();

  const alert = alertOverride ?? storeAlert;

  const [applyState, setApplyState] = useState<ApplyState>({ status: "idle" });

  // ESC closes the dock.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") hideDock();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const onViewDiff = () => {
    if (!alert?.suggestedFixId) return;
    openDiff({ alertId: alert.id, fixId: alert.suggestedFixId });
  };

  const onApply = async () => {
    if (!alert?.suggestedFixId) return;
    setApplyState({ status: "running" });
    let result: ApplyFixResult;
    try {
      result = await applyFix(alert.id, alert.suggestedFixId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      setApplyState({ status: "fail", message });
      return;
    }
    if (result.success) {
      setApplyState({ status: "success", message: result.deploymentUrl });
    } else {
      setApplyState({ status: "fail", message: result.message });
    }
  };

  const onOpenEditor = () => {
    if (!alert) return;
    // Use the suggested fix's filePath when available; fall back to the
    // alert's first stack frame line. Sesión 17 wires real frame parsing.
    const firstLine = alert.stackTrace.split("\n")[0] ?? "";
    const lineMatch = /:(\d+)(?::\d+)?$/.exec(firstLine);
    const lineNo = lineMatch ? parseInt(lineMatch[1] ?? "0", 10) : undefined;
    void openInEditor(alert.suggestedFixId ?? alert.id, lineNo);
  };

  const sourceLabel = useMemo(() => {
    if (!alert) return "";
    return alert.source.charAt(0).toUpperCase() + alert.source.slice(1);
  }, [alert]);

  if (!alert) {
    return (
      <div
        data-testid="dock-alert"
        data-empty="true"
        className="flex flex-col items-center justify-center h-full text-sm text-[var(--muted)] gap-2"
      >
        <ShieldCheck className="h-6 w-6 text-[var(--color-success)]" aria-hidden />
        <span>No alert selected.</span>
      </div>
    );
  }

  const visuals = SEVERITY_VISUALS[alert.severity];
  const { Icon } = visuals;

  return (
    <div data-testid="dock-alert" className="flex flex-col h-full">
      {/* Header */}
      <header
        data-testid="dock-alert-header"
        className="flex items-start gap-3 px-4 py-3 border-b border-[var(--border)]"
      >
        <Icon
          className={cn("h-5 w-5 shrink-0 mt-[2px]", visuals.toneClass)}
          aria-hidden
        />
        <div className="flex-1 min-w-0">
          <h2
            data-testid="dock-alert-title"
            className="text-sm font-semibold text-[var(--text)] line-clamp-2"
          >
            {alert.title}
          </h2>
          <div className="mt-1 flex items-center gap-2 text-xs text-[var(--muted)]">
            <span
              data-testid="dock-alert-source"
              className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-[var(--surface)] text-[var(--text)]"
            >
              from {sourceLabel}
            </span>
            <span aria-hidden>·</span>
            <span title={absoluteTime(alert.timestamp)}>
              {relativeTime(alert.timestamp)}
            </span>
            <span aria-hidden>·</span>
            <span className={cn("uppercase tracking-wide", visuals.toneClass)}>
              {visuals.label}
            </span>
          </div>
        </div>
      </header>

      {/* Body */}
      <div
        data-testid="dock-alert-body"
        className="flex-1 overflow-auto px-4 py-3 flex flex-col gap-3"
      >
        {alert.stackTrace ? (
          <section>
            <h3 className="text-[0.65rem] uppercase tracking-wide text-[var(--muted)] mb-1">
              Stack trace
            </h3>
            <pre
              className={cn(
                "text-xs leading-relaxed font-[var(--font-mono)]",
                "p-2 rounded-[var(--radius-sm)] bg-[var(--surface)]",
                "border border-[var(--border)] overflow-auto",
                "text-[var(--text)]",
              )}
              data-testid="dock-alert-stack"
            >
              {alert.stackTrace}
            </pre>
          </section>
        ) : null}

        {alert.aiDiagnosis ? (
          <section>
            <h3 className="text-[0.65rem] uppercase tracking-wide text-[var(--muted)] mb-1">
              Diagnosis
            </h3>
            <div
              data-testid="dock-alert-diagnosis"
              className={cn(
                "text-sm leading-relaxed font-[var(--font-serif)]",
                "text-[var(--text)] whitespace-pre-wrap",
              )}
            >
              {alert.aiDiagnosis}
            </div>
          </section>
        ) : null}

        <section
          data-testid="dock-alert-meta"
          className="flex flex-wrap items-center gap-2"
        >
          <ConfidenceBadge value={alert.metadata.confidence} />
          <span
            data-testid="dock-alert-risk"
            className={cn(
              "inline-flex items-center gap-1 px-2 py-0.5",
              "rounded-[var(--radius-sm)] border border-[var(--border)]",
              "bg-[var(--surface)] text-xs font-[var(--font-mono)]",
              alert.metadata.risk > 60
                ? "text-[var(--color-danger)]"
                : alert.metadata.risk > 30
                  ? "text-[var(--color-warning)]"
                  : "text-[var(--color-success)]",
            )}
          >
            <ShieldAlert className="h-3 w-3" aria-hidden /> risk{" "}
            {alert.metadata.risk}%
          </span>
          <span
            data-testid="dock-alert-lines"
            className={cn(
              "inline-flex items-center gap-1 px-2 py-0.5",
              "rounded-[var(--radius-sm)] border border-[var(--border)]",
              "bg-[var(--surface)] text-xs font-[var(--font-mono)]",
              "text-[var(--text)]",
            )}
          >
            <FileCode className="h-3 w-3" aria-hidden />
            ±{alert.metadata.linesChanged} lines
          </span>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-[var(--muted)]">
            <GitBranch className="h-3 w-3" aria-hidden />
            {alert.suggestedFixId ? "fix suggested" : "no suggested fix"}
          </span>
        </section>
      </div>

      {/* Footer */}
      <footer
        data-testid="dock-alert-footer"
        className="flex items-center gap-2 px-4 h-12 border-t border-[var(--border)]"
      >
        <Button
          size="sm"
          variant="primary"
          onClick={onViewDiff}
          disabled={!alert.suggestedFixId}
          data-testid="dock-alert-view-diff"
        >
          View diff
        </Button>
        <ApplyButton
          state={applyState}
          onClick={onApply}
          disabled={!alert.suggestedFixId}
          reduce={reduce}
          testid="dock-alert-apply"
          label="Apply & deploy"
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={onOpenEditor}
          data-testid="dock-alert-open-editor"
        >
          <Pencil className="h-3 w-3" aria-hidden />
          Open in editor
        </Button>
      </footer>
    </div>
  );
}

interface ApplyButtonProps {
  state: ApplyState;
  onClick: () => void;
  disabled: boolean;
  reduce: boolean | null;
  testid: string;
  label: string;
}

/**
 * Button that morphs in-place: idle → progress bar (during the IPC) →
 * checkmark on success / cross on failure. Used by both Mode 3 and
 * Mode 4 for the "apply" surface.
 */
export function ApplyButton({
  state,
  onClick,
  disabled,
  reduce,
  testid,
  label,
}: ApplyButtonProps) {
  if (state.status === "running") {
    return (
      <div
        data-testid={`${testid}-progress`}
        className={cn(
          "h-7 px-3 inline-flex items-center justify-center gap-2",
          "rounded-[var(--radius-sm)] border border-[var(--border)]",
          "bg-[var(--surface)] text-xs text-[var(--muted)]",
          "min-w-[10rem]",
        )}
      >
        <span>Applying…</span>
        <div className="flex-1 h-[3px] rounded-full bg-[var(--border)] overflow-hidden">
          <motion.div
            className="h-full bg-[var(--color-primary)]"
            initial={{ width: "0%" }}
            animate={{ width: "100%" }}
            transition={{ duration: reduce ? 0.001 : 1.2, ease: "easeOut" }}
          />
        </div>
      </div>
    );
  }
  if (state.status === "success") {
    return (
      <motion.div
        data-testid={`${testid}-success`}
        initial={reduce ? { opacity: 1 } : { scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={
          reduce ? { duration: 0 } : { type: "spring", stiffness: 320, damping: 22 }
        }
        className={cn(
          "h-7 px-3 inline-flex items-center gap-1 rounded-[var(--radius-sm)]",
          "border border-[var(--color-success)]",
          "bg-[color:color-mix(in_oklch,var(--color-success)_15%,transparent)]",
          "text-xs text-[var(--color-success)]",
        )}
      >
        ✓ Applied
        {state.message ? (
          <a
            href={state.message}
            target="_blank"
            rel="noreferrer"
            className="ml-1 underline decoration-dotted hover:text-[var(--text)]"
          >
            <ExternalLink className="inline h-3 w-3" aria-hidden /> deploy
          </a>
        ) : null}
      </motion.div>
    );
  }
  if (state.status === "fail") {
    return (
      <div
        data-testid={`${testid}-fail`}
        className={cn(
          "h-7 px-3 inline-flex items-center gap-1 rounded-[var(--radius-sm)]",
          "border border-[var(--color-danger)]",
          "bg-[color:color-mix(in_oklch,var(--color-danger)_15%,transparent)]",
          "text-xs text-[var(--color-danger)]",
        )}
        title={state.message ?? "Apply failed"}
      >
        ✗ {state.message ?? "Failed"}
      </div>
    );
  }
  return (
    <Button
      size="sm"
      onClick={onClick}
      disabled={disabled}
      data-testid={testid}
    >
      <Rocket className="h-3 w-3" aria-hidden />
      {label}
    </Button>
  );
}
