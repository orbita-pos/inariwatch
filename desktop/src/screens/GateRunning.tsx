import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  CheckCircle2,
  ChevronRight,
  Loader2,
  ShieldAlert,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { requestBypass } from "@/lib/dock-ipc";
import { useChat } from "@/lib/store/chat";
import { useGates, type GateEntry, type GateState } from "@/lib/store/gates";

/**
 * Mode 5 — pre-push gate runner timeline.
 *
 * Mounts when the daemon emits `GateRunStarted`; renders one row per
 * gate with stagger 50ms reveal; rows transition pending → running
 * (spinner) → passed/failed/deferred via store updates dispatched
 * from the `daemon:event` listener (DockShell installs it).
 *
 * The footer surfaces:
 *   * `Push allowed` (green) when allowed=true; `[Continue]` button
 *     dismisses Mode 5 (the actual `git push` is already proceeding
 *     because the HTTP handler returned `allow=true`).
 *   * `Push blocked: N gate(s) failed` (red) when allowed=false;
 *     `[Push anyway]` calls `request_bypass` (audit-only — the user
 *     still needs to re-run `INARI_BYPASS=1 git push` manually);
 *     `[Open diff]` bounces back to Mode 4 if there's a draft fix.
 */
export function GateRunning() {
  const reduce = useReducedMotion();
  const { activeRunId, gates, allowed, blockingGates, totalLatencyMs, clear } =
    useGates();
  const setMode = useChat((s) => s.setMode);

  const inFlight = allowed === null;
  const blockedCount = blockingGates.length;

  return (
    <motion.div
      data-testid="gate-running"
      className="h-full w-full flex flex-col p-5 gap-3"
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
      animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0 } : { duration: 0.18, ease: "easeOut" }}
    >
      <header className="flex items-center gap-2">
        <ShieldAlert className="w-5 h-5 text-[var(--color-accent)]" aria-hidden />
        <h2 className="text-sm font-semibold tracking-tight">
          {inFlight ? "Running pre-push gates…" : "Pre-push verdict"}
        </h2>
      </header>

      <ol className="flex-1 flex flex-col gap-1 overflow-y-auto" data-testid="gate-list">
        <AnimatePresence initial={false}>
          {gates.map((g, idx) => (
            <GateRow key={g.name} gate={g} index={idx} reduce={!!reduce} />
          ))}
        </AnimatePresence>
      </ol>

      <footer className="flex flex-col gap-2 border-t border-[var(--border)] pt-3">
        {inFlight ? (
          <p className="text-xs text-[var(--text-muted)]">
            Evaluating {gates.length} gates in parallel…
          </p>
        ) : allowed ? (
          <PushAllowed
            totalLatencyMs={totalLatencyMs ?? 0}
            onContinue={() => {
              clear();
              setMode("idle");
            }}
          />
        ) : (
          <PushBlocked
            runId={activeRunId}
            blockedCount={blockedCount}
            blockingGates={blockingGates}
            totalLatencyMs={totalLatencyMs ?? 0}
            onDismiss={() => {
              clear();
              setMode("idle");
            }}
            onOpenDiff={() => {
              clear();
              // Forward to Mode 4 (diff viewer) — the dock keeps the
              // last `currentFix` cached, so this transitions cleanly
              // when the active run came from a remediation flow.
              setMode("diff");
            }}
          />
        )}
      </footer>
    </motion.div>
  );
}

interface GateRowProps {
  gate: GateEntry;
  index: number;
  reduce: boolean;
}

function GateRow({ gate, index, reduce }: GateRowProps) {
  const { Icon, tone, label } = visualsFor(gate.state);
  return (
    <motion.li
      data-testid={`gate-row-${gate.name}`}
      data-state={gate.state}
      className={cn(
        "flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)]",
        "border border-[var(--border)]/40 bg-[var(--bg-elev)]/40",
      )}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
      animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
      transition={
        reduce
          ? { duration: 0 }
          : { duration: 0.16, ease: "easeOut", delay: index * 0.05 }
      }
    >
      <Icon className={cn("w-4 h-4 flex-none", tone)} aria-hidden />
      <span className="flex-1 text-sm font-medium">{prettyName(gate.name)}</span>
      <span className={cn("text-xs", tone)}>{label}</span>
      {typeof gate.latencyMs === "number" && gate.state !== "running" && gate.state !== "pending" ? (
        <span className="text-[10px] text-[var(--text-muted)] tabular-nums">
          {gate.latencyMs}ms
        </span>
      ) : null}
      {gate.reason && gate.state === "failed" ? (
        <p className="basis-full mt-1 text-[11px] text-[var(--text-muted)]">
          {gate.reason}
        </p>
      ) : null}
    </motion.li>
  );
}

interface PushAllowedProps {
  totalLatencyMs: number;
  onContinue: () => void;
}

function PushAllowed({ totalLatencyMs, onContinue }: PushAllowedProps) {
  return (
    <div className="flex items-center gap-3">
      <span
        data-testid="verdict-allowed"
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium bg-[color-mix(in_oklab,var(--color-success)_15%,transparent)] text-[var(--color-success)]"
      >
        <CheckCircle2 className="w-3.5 h-3.5" aria-hidden />
        Push allowed
      </span>
      <span className="text-[10px] text-[var(--text-muted)] tabular-nums">
        {totalLatencyMs}ms
      </span>
      <Button size="sm" className="ml-auto" onClick={onContinue}>
        Continue
        <ChevronRight className="w-3.5 h-3.5" aria-hidden />
      </Button>
    </div>
  );
}

interface PushBlockedProps {
  runId: string | null;
  blockedCount: number;
  blockingGates: string[];
  totalLatencyMs: number;
  onDismiss: () => void;
  onOpenDiff: () => void;
}

function PushBlocked({
  runId,
  blockedCount,
  blockingGates,
  totalLatencyMs,
  onDismiss,
  onOpenDiff,
}: PushBlockedProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span
          data-testid="verdict-blocked"
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium bg-[color-mix(in_oklab,var(--color-danger)_15%,transparent)] text-[var(--color-danger)]"
        >
          <XCircle className="w-3.5 h-3.5" aria-hidden />
          Push blocked: {blockedCount} {blockedCount === 1 ? "gate" : "gates"} failed
        </span>
        <span className="text-[10px] text-[var(--text-muted)] tabular-nums">
          {totalLatencyMs}ms
        </span>
      </div>
      <p className="text-[11px] text-[var(--text-muted)]">
        Failing: {blockingGates.map(prettyName).join(", ")}
      </p>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          data-testid="bypass-button"
          onClick={async () => {
            if (runId) await requestBypass(runId, "user override from dock");
            onDismiss();
          }}
        >
          Push anyway (override)
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-testid="open-diff-button"
          onClick={onOpenDiff}
        >
          Open diff
        </Button>
        <Button size="sm" className="ml-auto" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

function visualsFor(state: GateState): {
  Icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  tone: string;
  label: string;
} {
  switch (state) {
    case "pending":
      return {
        Icon: Loader2,
        tone: "text-[var(--text-muted)]",
        label: "pending",
      };
    case "running":
      return {
        Icon: SpinnerIcon,
        tone: "text-[var(--color-accent)]",
        label: "running",
      };
    case "passed":
      return {
        Icon: CheckCircle2,
        tone: "text-[var(--color-success)]",
        label: "passed",
      };
    case "failed":
      return {
        Icon: XCircle,
        tone: "text-[var(--color-danger)]",
        label: "failed",
      };
    case "deferred":
      return {
        Icon: CheckCircle2,
        tone: "text-[var(--text-muted)]",
        label: "skipped",
      };
  }
}

function SpinnerIcon({ className, ...rest }: { className?: string; "aria-hidden"?: boolean }) {
  return <Loader2 className={cn("animate-spin", className)} {...rest} />;
}

function prettyName(raw: string): string {
  switch (raw) {
    case "self_review":        return "Self-review";
    case "substrate_simulate": return "Substrate replay";
    case "security_scan":      return "Security scan";
    case "auto_merge_enabled": return "Auto-merge enabled";
    case "lines_changed":      return "Lines changed";
    default:                   return raw.replace(/_/g, " ");
  }
}
