import {
  CheckCircle2,
  Loader2,
  Play,
  RotateCcw,
  Sparkles,
  XCircle,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  replayAgainstPatch,
  type ReplayResultDto,
} from "@/lib/dock-ipc";

interface ReplayButtonProps {
  /** Remediation session id. When null the button is disabled (not yet wired). */
  sessionId: string | null;
  /** Alert id the receipt attests to. Forwarded for audit on the daemon side. */
  alertId: string | null;
  /**
   * `true` when the EAP receipt has a `recording_id`. When `false` the
   * button surfaces the "no recording — generate one" CTA per the
   * Sesión 27 spec instead of attempting the call.
   */
  hasRecording: boolean;
  /** Test override — bypasses real IPC. Useful for component tests. */
  invoke?: (
    sessionId: string,
    alertId: string,
  ) => Promise<ReplayResultDto>;
}

type ButtonState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "result"; result: ReplayResultDto };

/**
 * Sesión 27 — replay-against-patch button. Three visual phases:
 *
 *   1. **idle**     — `▶ Replay` button. Disabled when `hasRecording`
 *                     is false (renders the no-recording CTA instead).
 *   2. **running**  — spinner + "Replaying…". Click is suppressed.
 *   3. **result**   — green ✓ when the replay returned and the throw
 *                     did NOT reproduce against the patch (i.e. the
 *                     fix prevented it); red ✗ otherwise. Red also
 *                     covers `request_failed` / `config_missing`.
 *
 * "no_recording" / "no_receipt" tagged variants funnel to the CTA
 * branch — the button never silently fails.
 */
export function ReplayButton({
  sessionId,
  alertId,
  hasRecording,
  invoke = replayAgainstPatch,
}: ReplayButtonProps) {
  const [state, setState] = useState<ButtonState>({ phase: "idle" });

  // No-recording → CTA, never enable the button. This branch is also
  // reached when the EAP chip has no recording_id (the rust IPC would
  // return `kind="no_recording"` on click, so we short-circuit it here
  // for clarity + zero-cost rendering).
  if (!hasRecording || !sessionId || !alertId) {
    return (
      <span
        data-testid="replay-button"
        data-replay-state="no-recording"
        className={cn(
          "inline-flex items-center gap-1 px-2 py-0.5",
          "rounded-[var(--radius-sm)] border border-dashed border-[var(--border)]",
          "bg-[var(--surface)] text-xs font-[var(--font-mono)]",
          "text-[var(--muted)]",
        )}
      >
        <Sparkles className="h-3 w-3 text-[var(--color-ai)]" aria-hidden />
        no recording — generate one
      </span>
    );
  }

  if (state.phase === "running") {
    return (
      <span
        data-testid="replay-button"
        data-replay-state="running"
        className={cn(
          "inline-flex items-center gap-1 px-2 py-0.5",
          "rounded-[var(--radius-sm)] border border-[var(--color-primary)]",
          "bg-[var(--surface)] text-xs font-[var(--font-mono)]",
          "text-[var(--color-primary)]",
        )}
      >
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        Replaying…
      </span>
    );
  }

  if (state.phase === "result") {
    return (
      <ReplayResultBadge
        result={state.result}
        onReset={() => setState({ phase: "idle" })}
      />
    );
  }

  const onClick = async () => {
    setState({ phase: "running" });
    let result: ReplayResultDto;
    try {
      result = await invoke(sessionId, alertId);
    } catch (e) {
      result = {
        kind: "request_failed",
        status: null,
        error: e instanceof Error ? e.message : "unknown error",
      };
    }
    setState({ phase: "result", result });
  };

  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      onClick={onClick}
      data-testid="replay-button"
      data-replay-state="idle"
      className="gap-1"
    >
      <Play className="h-3 w-3" aria-hidden /> Replay
    </Button>
  );
}

interface ReplayResultBadgeProps {
  result: ReplayResultDto;
  onReset: () => void;
}

function ReplayResultBadge({ result, onReset }: ReplayResultBadgeProps) {
  if (result.kind === "ok") {
    const passed = !result.throwReproduced;
    return (
      <span
        data-testid="replay-button"
        data-replay-state={passed ? "passed" : "diverged"}
        className={cn(
          "inline-flex items-center gap-1 px-2 py-0.5",
          "rounded-[var(--radius-sm)] border",
          "bg-[var(--surface)] text-xs font-[var(--font-mono)]",
          passed
            ? "border-[var(--color-success)] text-[var(--color-success)]"
            : "border-[var(--color-danger)] text-[var(--color-danger)]",
        )}
        title={resultTitle(result)}
      >
        {passed ? (
          <CheckCircle2 className="h-3 w-3" aria-hidden />
        ) : (
          <XCircle className="h-3 w-3" aria-hidden />
        )}
        {passed ? "Fix prevented throw" : "Fix didn't prevent throw"}
        {result.durationMs != null ? (
          <span
            data-testid="replay-button-duration"
            className="text-[var(--muted)]"
          >
            · {Math.round(result.durationMs)} ms
          </span>
        ) : null}
        <button
          type="button"
          onClick={onReset}
          aria-label="Reset replay"
          className={cn(
            "ml-1 inline-flex items-center text-[var(--muted)]",
            "hover:text-[var(--text)]",
          )}
        >
          <RotateCcw className="h-3 w-3" aria-hidden />
        </button>
      </span>
    );
  }

  // The other tagged variants (`no_recording` / `no_receipt`) reach
  // here only when the rust IPC overrides the frontend's
  // `hasRecording` gate (race with a stale chip). Funnel them to the
  // same CTA copy the disabled-state branch uses.
  if (result.kind === "no_recording" || result.kind === "no_receipt") {
    return (
      <span
        data-testid="replay-button"
        data-replay-state="no-recording"
        className={cn(
          "inline-flex items-center gap-1 px-2 py-0.5",
          "rounded-[var(--radius-sm)] border border-dashed border-[var(--border)]",
          "bg-[var(--surface)] text-xs font-[var(--font-mono)]",
          "text-[var(--muted)]",
        )}
      >
        <Sparkles className="h-3 w-3 text-[var(--color-ai)]" aria-hidden />
        no recording — generate one
      </span>
    );
  }

  // Failure paths (config_missing / request_failed) render as red ✗
  // with a rest button so the user can retry without remounting.
  const errorMessage =
    result.kind === "config_missing"
      ? `Replay not configured: ${result.reason}`
      : `Replay failed${result.status ? ` (HTTP ${result.status})` : ""}: ${result.error}`;

  return (
    <span
      data-testid="replay-button"
      data-replay-state="failed"
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5",
        "rounded-[var(--radius-sm)] border border-[var(--color-danger)]",
        "bg-[var(--surface)] text-xs font-[var(--font-mono)]",
        "text-[var(--color-danger)]",
      )}
      title={errorMessage}
    >
      <XCircle className="h-3 w-3" aria-hidden />
      <span data-testid="replay-button-error" className="max-w-[18ch] truncate">
        {errorMessage}
      </span>
      <button
        type="button"
        onClick={onReset}
        aria-label="Retry replay"
        className={cn(
          "ml-1 inline-flex items-center text-[var(--muted)]",
          "hover:text-[var(--text)]",
        )}
      >
        <RotateCcw className="h-3 w-3" aria-hidden />
      </button>
    </span>
  );
}

function resultTitle(result: ReplayResultDto): string {
  if (result.kind !== "ok") return "";
  const head = result.headThrow;
  const headSummary = head
    ? `${head.exceptionName}: ${head.exceptionMessage}`
    : "no throws";
  return `Throws after patch: ${result.throwsAfter} — ${headSummary}`;
}
