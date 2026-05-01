import { motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  CheckCircle2,
  Lock,
  RotateCcw,
  Sparkles,
  XCircle,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { ConfidenceBadge } from "@/components/ConfidenceBadge";
import { DiffViewer, type DiffViewMode } from "@/components/DiffViewer";
import { GateChecklist } from "@/components/GateChecklist";
import { ApplyButton } from "@/screens/DockAlert";
import { Button, Dialog, DialogClose } from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  applyFix,
  applyRemediation,
  getFixById,
  modifyWithAi,
  openEapReceipt,
  rejectFix,
  rejectRemediation,
  type ApplyFixResult,
} from "@/lib/dock-ipc";
import { useChat } from "@/lib/store/chat";
import type { Fix } from "@/types/alert";

interface DockDiffProps {
  /** Test override; production reads from `useChat.currentFix`. */
  fixOverride?: Fix | null;
}

interface ApplyState {
  status: "idle" | "running" | "success" | "fail";
  message?: string;
}

/**
 * Dock Mode 4 — diff viewer (the money shot). Header / DiffViewer /
 * gates + replay + EAP indicators / footer. The view-mode toggle and
 * confidence badge live in the header; the footer carries the three
 * action buttons (Reject / Modify with AI / Apply & commit).
 *
 * Production resolves the Fix from `useChat.currentFix`; if it's null
 * but `pendingDiff` is set, the screen calls `getFixById` to populate
 * the store. Tests bypass via `fixOverride`.
 */
export function DockDiff({ fixOverride = null }: DockDiffProps) {
  const storeFix = useChat((s) => s.currentFix);
  const pendingDiff = useChat((s) => s.pendingDiff);
  const backToAlert = useChat((s) => s.backToAlert);
  // Sesión 19: when set, route apply / reject through the remediation
  // orchestrator instead of the legacy S16 alert-fix stubs.
  const remediationSessionId = useChat((s) => s.remediationSessionId);
  const reduce = useReducedMotion();

  const fix = fixOverride ?? storeFix;
  const [resolved, setResolved] = useState<Fix | null>(fix);
  const [view, setView] = useState<DiffViewMode>("inline");
  const [applyState, setApplyState] = useState<ApplyState>({ status: "idle" });
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [modifyOpen, setModifyOpen] = useState(false);
  const [modifyValue, setModifyValue] = useState("");
  const [diffString, setDiffString] = useState<string>(fix?.diff ?? "");

  // Sync resolved + diff string when the store-supplied fix changes.
  useEffect(() => {
    setResolved(fix);
    setDiffString(fix?.diff ?? "");
  }, [fix]);

  // If the store has only the lookup id, fetch via IPC.
  useEffect(() => {
    if (resolved) return;
    if (!pendingDiff) return;
    let cancelled = false;
    getFixById(pendingDiff.fixId).then((f) => {
      if (cancelled) return;
      if (f) {
        setResolved(f);
        setDiffString(f.diff);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [resolved, pendingDiff]);

  // Preserve scroll position across inline ↔ side-by-side toggles.
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollSaveRef = useRef<number | null>(null);
  const onToggleView = (next: DiffViewMode) => {
    if (bodyRef.current) {
      scrollSaveRef.current = bodyRef.current.scrollTop;
    }
    setView(next);
  };
  useLayoutEffect(() => {
    if (scrollSaveRef.current !== null && bodyRef.current) {
      // Restore on the next frame so the layout has had a chance to mount.
      const target = scrollSaveRef.current;
      requestAnimationFrame(() => {
        if (bodyRef.current) bodyRef.current.scrollTop = target;
      });
      scrollSaveRef.current = null;
    }
  }, [view]);

  if (!resolved) {
    return (
      <div
        data-testid="dock-diff"
        data-empty="true"
        className="flex flex-col items-center justify-center h-full text-sm text-[var(--muted)] gap-3"
      >
        <Sparkles className="h-6 w-6 text-[var(--color-ai)]" aria-hidden />
        <span>Loading fix…</span>
        <Button size="sm" variant="ghost" onClick={backToAlert}>
          <ArrowLeft className="h-3 w-3" aria-hidden /> Back
        </Button>
      </div>
    );
  }

  const onApply = async () => {
    setApplyState({ status: "running" });
    // Sesión 19 path: when the dock entered Mode 4 via the local
    // remediation orchestrator, route the apply through the
    // `apply_remediation` IPC. The legacy S16 `applyFix` (alert-fix
    // deploy stub) stays as the default for the existing flow.
    if (remediationSessionId) {
      try {
        const r = await applyRemediation(remediationSessionId);
        if (r.success) {
          setApplyState({
            status: "success",
            message: r.commitSha ?? r.message,
          });
        } else {
          setApplyState({ status: "fail", message: r.message });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown error";
        setApplyState({ status: "fail", message });
      }
      return;
    }
    let result: ApplyFixResult;
    try {
      result = await applyFix(resolved.alertId, resolved.id);
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

  const onConfirmReject = async () => {
    if (remediationSessionId) {
      await rejectRemediation(remediationSessionId, rejectReason || undefined);
    } else {
      await rejectFix(resolved.id, rejectReason || undefined);
    }
    setRejectOpen(false);
    backToAlert();
  };

  const onSubmitModify = async () => {
    if (!modifyValue.trim()) return;
    const result = await modifyWithAi(resolved.id, modifyValue.trim());
    if (result.success && result.newDiff) {
      setDiffString(result.newDiff);
    }
    setModifyOpen(false);
    setModifyValue("");
  };

  const passCount = resolved.gates.filter((g) => g.status === "pass").length;
  const totalCount = resolved.gates.length;
  // Confidence is the maximum gate-pass ratio (0–100). When the Fix
  // payload has its own metadata source (Sesión 19), pass that through
  // a prop instead.
  const confidence =
    totalCount > 0 ? Math.round((passCount / totalCount) * 100) : 0;

  return (
    <div data-testid="dock-diff" className="flex flex-col h-full">
      {/* Header */}
      <header
        data-testid="dock-diff-header"
        className="flex items-center gap-2 px-4 h-12 border-b border-[var(--border)]"
      >
        <button
          type="button"
          onClick={backToAlert}
          aria-label="Back to alert"
          data-testid="dock-diff-back"
          className={cn(
            "inline-flex items-center justify-center h-7 w-7",
            "rounded-[var(--radius-sm)] text-[var(--muted)]",
            "hover:bg-[var(--surface)] hover:text-[var(--text)]",
            "transition-colors duration-[var(--duration-fast)]",
          )}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
        </button>
        <span
          data-testid="dock-diff-filename"
          className="flex-1 truncate text-sm font-[var(--font-mono)] text-[var(--text)]"
        >
          {resolved.filePath}
        </span>
        <div
          role="group"
          aria-label="View mode"
          data-testid="dock-diff-view-toggle"
          className="inline-flex border border-[var(--border)] rounded-[var(--radius-sm)] overflow-hidden text-xs"
        >
          {(["inline", "side-by-side"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onToggleView(m)}
              data-testid={`dock-diff-view-${m}`}
              data-active={view === m ? "true" : "false"}
              className={cn(
                "px-2 py-1 transition-colors duration-[var(--duration-fast)]",
                view === m
                  ? "bg-[var(--color-primary)] text-white"
                  : "bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--text)]",
              )}
            >
              {m === "inline" ? "Inline" : "Side-by-side"}
            </button>
          ))}
        </div>
        <ConfidenceBadge value={confidence} />
      </header>

      {/* Body */}
      <div
        ref={bodyRef}
        data-testid="dock-diff-body"
        className="flex-1 overflow-auto px-4 py-3 flex flex-col gap-3"
      >
        <motion.div
          layout={reduce ? false : "size"}
          transition={
            reduce ? { duration: 0 } : { duration: 0.18, ease: "easeOut" }
          }
        >
          <DiffViewer
            diff={diffString}
            language={resolved.language}
            mode={view}
          />
        </motion.div>

        {/* Replay + EAP indicators */}
        <section
          data-testid="dock-diff-indicators"
          className="flex flex-wrap items-center gap-2"
        >
          <ReplayIndicator value={resolved.replayMatch} />
          <EapIndicator
            signature={resolved.eapSignature}
            onClick={() =>
              resolved.eapSignature && openEapReceipt(resolved.eapSignature)
            }
          />
          <span
            data-testid="dock-diff-gate-summary"
            className="text-xs text-[var(--muted)] font-[var(--font-mono)]"
          >
            {passCount}/{totalCount} gates passed
          </span>
        </section>

        {/* 17 gate checklist */}
        <section>
          <h3 className="text-[0.65rem] uppercase tracking-wide text-[var(--muted)] mb-1">
            Gates
          </h3>
          <GateChecklist gates={resolved.gates} />
        </section>
      </div>

      {/* Footer */}
      <footer
        data-testid="dock-diff-footer"
        className="flex items-center gap-2 px-4 h-12 border-t border-[var(--border)]"
      >
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setRejectOpen(true)}
          data-testid="dock-diff-reject"
        >
          Reject
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setModifyOpen(true)}
          data-testid="dock-diff-modify"
        >
          <Sparkles className="h-3 w-3" aria-hidden /> Modify with AI
        </Button>
        <ApplyButton
          state={applyState}
          onClick={onApply}
          disabled={false}
          reduce={reduce}
          testid="dock-diff-apply"
          label="Apply & commit"
        />
      </footer>

      {/* Reject reason dialog */}
      <Dialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        title="Reject this fix?"
        description="Optional — share why so Inari learns from the call."
      >
        <textarea
          data-testid="dock-diff-reject-reason"
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          placeholder="Wrong file, doesn't address root cause, …"
          className={cn(
            "w-full min-h-[6rem] p-2 rounded-[var(--radius-sm)]",
            "border border-[var(--border)] bg-[var(--surface)]",
            "text-sm text-[var(--text)] outline-none focus:border-[var(--color-primary)]",
          )}
        />
        <div className="mt-3 flex justify-end gap-2">
          <DialogClose asChild>
            <Button size="sm" variant="ghost">
              Cancel
            </Button>
          </DialogClose>
          <Button
            size="sm"
            variant="danger"
            onClick={onConfirmReject}
            data-testid="dock-diff-reject-confirm"
          >
            Reject
          </Button>
        </div>
      </Dialog>

      {/* Modify-with-AI dialog */}
      <Dialog
        open={modifyOpen}
        onOpenChange={setModifyOpen}
        title="Modify this fix with AI"
        description="Tell Inari what to change about the proposed diff."
      >
        <textarea
          data-testid="dock-diff-modify-input"
          value={modifyValue}
          onChange={(e) => setModifyValue(e.target.value)}
          placeholder="Use a typed enum instead of a string union."
          className={cn(
            "w-full min-h-[6rem] p-2 rounded-[var(--radius-sm)]",
            "border border-[var(--border)] bg-[var(--surface)]",
            "text-sm text-[var(--text)] outline-none focus:border-[var(--color-primary)]",
          )}
        />
        <div className="mt-3 flex justify-end gap-2">
          <DialogClose asChild>
            <Button size="sm" variant="ghost">
              Cancel
            </Button>
          </DialogClose>
          <Button
            size="sm"
            variant="primary"
            onClick={onSubmitModify}
            data-testid="dock-diff-modify-confirm"
          >
            Modify
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

interface ReplayIndicatorProps {
  value: boolean | null;
}

function ReplayIndicator({ value }: ReplayIndicatorProps) {
  let label = "Replay not run";
  let tone = "text-[var(--muted)] border-[var(--border)]";
  let Icon = RotateCcw;
  if (value === true) {
    label = "Replay matched";
    tone = "text-[var(--color-success)] border-[var(--color-success)]";
    Icon = CheckCircle2;
  } else if (value === false) {
    label = "Replay diverged";
    tone = "text-[var(--color-danger)] border-[var(--color-danger)]";
    Icon = XCircle;
  }
  return (
    <span
      data-testid="dock-diff-replay"
      data-replay-state={value === null ? "unknown" : value ? "match" : "diverge"}
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5",
        "rounded-[var(--radius-sm)] border bg-[var(--surface)]",
        "text-xs font-[var(--font-mono)]",
        tone,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden /> {label}
    </span>
  );
}

interface EapIndicatorProps {
  signature: string | null;
  onClick: () => void;
}

function EapIndicator({ signature, onClick }: EapIndicatorProps) {
  if (!signature) {
    return (
      <span
        data-testid="dock-diff-eap"
        data-eap-state="unsigned"
        className={cn(
          "inline-flex items-center gap-1 px-2 py-0.5",
          "rounded-[var(--radius-sm)] border border-[var(--border)]",
          "bg-[var(--surface)] text-xs font-[var(--font-mono)]",
          "text-[var(--muted)]",
        )}
      >
        <Lock className="h-3 w-3" aria-hidden /> Unsigned
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="dock-diff-eap"
      data-eap-state="signed"
      title={`Receipt: ${signature.slice(0, 16)}…`}
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5",
        "rounded-[var(--radius-sm)] border border-[var(--color-primary)]",
        "bg-[var(--surface)] text-xs font-[var(--font-mono)]",
        "text-[var(--color-primary)] hover:brightness-110",
      )}
    >
      <Lock className="h-3 w-3" aria-hidden /> EAP-signed
    </button>
  );
}
