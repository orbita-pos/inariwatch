import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Check,
  ChevronDown,
  KeyRound,
  ShieldOff,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useState } from "react";

import { WitnessVerifierModal } from "@/components/audit/WitnessVerifierModal";
import { useChat, type ToolCall, type ToolCallStatus } from "@/lib/store/chat";
import { useSettings } from "@/lib/store/settings";
import {
  desktopToolConfirm,
  type InvokeOutcome,
} from "@/lib/tool-invoke-ipc";

interface ToolCallCardProps {
  /**
   * S6 contract: when this card lives inside an assistant message, the
   * caller passes `messageId` so the confirm/cancel buttons can patch
   * the call back into the chat store via `useChat.updateToolCall`.
   * Older callers (the v0.2 placeholder test fixture) omit it; the
   * card then renders read-only and skips the confirm path.
   */
  messageId?: string;
  toolCall: ToolCall;
  /**
   * Optional injection seam for tests. Defaults to the real
   * `desktop_tool_confirm` IPC; tests pass a stub so they can assert
   * the call without touching Tauri.
   */
  invokeConfirm?: typeof desktopToolConfirm;
}

function pretty(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Render a 1-line summary of the tool's args. Strings get inline
 * quotes; objects get `{ k: v, ... }` flattened to the first ~3 keys
 * so the row stays single-line. Full JSON is reachable via
 * click-to-expand.
 */
function summarizeArgs(value: unknown): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "string") return `"${value}"`;
  if (typeof value !== "object") return String(value);
  try {
    const obj = value as Record<string, unknown>;
    const entries = Object.entries(obj).slice(0, 3);
    if (entries.length === 0) return "{}";
    const parts = entries.map(([k, v]) => {
      let rendered: string;
      if (typeof v === "string") rendered = `"${v}"`;
      else if (v === null || v === undefined) rendered = String(v);
      else if (typeof v === "object") rendered = "…";
      else rendered = String(v);
      return `${k}: ${rendered}`;
    });
    return `{ ${parts.join(", ")}${Object.keys(obj).length > 3 ? ", …" : ""} }`;
  } catch {
    return "—";
  }
}

function summarizeOutput(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 117)}…` : value;
  if (typeof value !== "object") return String(value);
  try {
    const obj = value as Record<string, unknown>;
    const summary = Object.entries(obj).slice(0, 2).map(([k, v]) => {
      const rv = typeof v === "object" && v !== null ? "{…}" : String(v);
      return `${k}: ${rv}`;
    });
    return summary.length ? summary.join(" · ") : "{…}";
  } catch {
    return "";
  }
}

/**
 * Inline rich card for an assistant tool call.
 *
 * Per the 2026-05-07 chat-first redesign: header has the tool name in
 * mono + a status pill on the right (sage for `done`, warm-gold for
 * `pending` / `requires_confirm`, soft-red for `denied` / `failed`).
 * Body always shows a 1-line `args` summary + a `→` result line.
 * Footer carries the witness chip on the left and an `inspect` link
 * on the right (clicking opens the S11 `WitnessVerifierModal`).
 *
 * Click anywhere on the header row to expand the full input/output
 * JSON below — preserves the v0.2 collapse contract that the
 * pre-S6 placeholder test relies on.
 */
export function ToolCallCard({
  messageId,
  toolCall,
  invokeConfirm = desktopToolConfirm,
}: ToolCallCardProps) {
  const [open, setOpen] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [confirmInFlight, setConfirmInFlight] = useState(false);
  const reduce = useReducedMotion();

  const updateToolCall = useChat((s) => s.updateToolCall);
  const sessionId = useChat((s) => s.sessionId);
  const setActiveSection = useSettings((s) => s.setActiveSection);
  const setFocusedTool = useSettings((s) => s.setFocusedTool);

  const status: ToolCallStatus = toolCall.status ?? "done";

  const onConfirmClick = useCallback(async () => {
    if (!messageId || confirmInFlight) return;
    setConfirmInFlight(true);
    updateToolCall(messageId, toolCall.id, { status: "executing" });
    try {
      const outcome = await invokeConfirm(
        toolCall.name,
        toolCall.input,
        sessionId,
      );
      applyOutcomeToStore(updateToolCall, messageId, toolCall.id, outcome);
    } catch (e: unknown) {
      const msg = typeof e === "string" ? e : (e as Error).message ?? "unknown";
      updateToolCall(messageId, toolCall.id, {
        status: "failed",
        error: msg,
      });
    } finally {
      setConfirmInFlight(false);
    }
  }, [
    messageId,
    confirmInFlight,
    invokeConfirm,
    toolCall.name,
    toolCall.input,
    toolCall.id,
    sessionId,
    updateToolCall,
  ]);

  const onCancelClick = useCallback(() => {
    if (!messageId) return;
    updateToolCall(messageId, toolCall.id, {
      status: "failed",
      error: "user cancelled",
    });
  }, [messageId, toolCall.id, updateToolCall]);

  const onPermissionsLink = useCallback(() => {
    setFocusedTool(toolCall.name);
    setActiveSection("permissions");
  }, [setActiveSection, setFocusedTool, toolCall.name]);

  const witnessHash = toolCall.invocationId
    ? `w_${toolCall.invocationId.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase()}`
    : null;
  const witnessVerified = status === "done" && witnessHash != null;

  return (
    <motion.div
      layout={reduce ? false : "size"}
      transition={
        reduce
          ? { duration: 0 }
          : { type: "spring", stiffness: 320, damping: 28 }
      }
      data-testid="tool-call-card"
      data-open={open ? "true" : "false"}
      data-status={status}
      className="overflow-hidden"
      style={{
        borderRadius: 12,
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.018), rgba(255,255,255,0)), var(--surface)",
        border:
          status === "confirming"
            ? "1px solid rgba(212,180,122,0.20)"
            : "1px solid var(--border-strong)",
        boxShadow:
          status === "confirming" ? "0 0 0 4px rgba(212,180,122,0.04)" : undefined,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-4 pt-3 text-left transition-colors focus:outline-none"
      >
        <div className="flex items-center gap-2.5">
          <Wrench
            size={13}
            strokeWidth={1.6}
            style={{ color: "var(--text-subtle)" }}
            aria-hidden
          />
          <span
            className="text-[12.5px]"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--text)",
            }}
          >
            {toolCall.name}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill status={status} />
          <motion.span
            aria-hidden
            animate={reduce ? undefined : { rotate: open ? 0 : -90 }}
            transition={{ duration: 0.15 }}
            style={{ color: "var(--text-faint)" }}
          >
            <ChevronDown size={12} />
          </motion.span>
        </div>
      </button>

      <div className="px-4 pt-2 pb-3 space-y-1.5">
        <div className="flex gap-2 text-[12.5px]">
          <span
            className="shrink-0 w-[44px]"
            style={{ fontFamily: "var(--font-mono)", color: "var(--text-faint)" }}
          >
            args
          </span>
          <span
            className="truncate min-w-0"
            style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}
            data-testid="tool-call-args-summary"
          >
            {summarizeArgs(toolCall.input)}
          </span>
        </div>
        {status === "done" && toolCall.output !== undefined ? (
          <div className="flex gap-2 text-[12.5px]">
            <span
              className="shrink-0 w-[44px]"
              style={{ fontFamily: "var(--font-mono)", color: "var(--text-faint)" }}
            >
              →
            </span>
            <span style={{ color: "var(--text)" }} data-testid="tool-call-output-summary">
              {summarizeOutput(toolCall.output)}
            </span>
          </div>
        ) : null}
        {status === "pending" || status === "executing" ? (
          <div className="flex gap-2 text-[12.5px]">
            <span
              className="shrink-0 w-[44px]"
              style={{ fontFamily: "var(--font-mono)", color: "var(--text-faint)" }}
            >
              →
            </span>
            <span className="italic" style={{ color: "var(--text-dim)" }}>
              {status === "executing" ? "running…" : "queued…"}
            </span>
          </div>
        ) : null}
        {status === "failed" && toolCall.error ? (
          <div className="flex gap-2 text-[12.5px]">
            <span
              className="shrink-0 w-[44px]"
              style={{ fontFamily: "var(--font-mono)", color: "var(--text-faint)" }}
            >
              error
            </span>
            <span data-testid="tool-call-error-banner" style={{ color: "var(--danger)" }}>
              {toolCall.error}
            </span>
          </div>
        ) : null}
      </div>

      {status === "confirming" ? (
        <div
          data-testid="tool-call-confirm-prompt"
          className="flex items-center justify-between px-4 py-2.5"
          style={{ borderTop: "1px solid rgba(212,180,122,0.15)" }}
        >
          <span className="text-[11.5px]" style={{ color: "var(--text-subtle)" }}>
            Out-of-cluster action. Inari needs your go-ahead.
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="tool-call-cancel-button"
              onClick={onCancelClick}
              disabled={confirmInFlight}
              className="h-7 px-3 rounded-lg text-[12px] transition-colors hover:bg-white/[0.025] disabled:opacity-50"
              style={{
                background: "transparent",
                color: "var(--text-muted)",
                border: "1px solid var(--border-strong)",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="tool-call-confirm-button"
              onClick={onConfirmClick}
              disabled={confirmInFlight}
              className="h-7 px-3.5 rounded-lg text-[12px] font-medium transition-transform active:scale-[0.98] disabled:opacity-50"
              style={{
                background: "var(--accent)",
                color: "var(--accent-ink)",
                border: "1px solid rgba(0,0,0,0.18)",
                boxShadow:
                  "inset 0 1px 0 rgba(255,255,255,0.55), inset 0 -1px 0 rgba(0,0,0,0.08), 0 1px 0 rgba(0,0,0,0.45)",
              }}
            >
              Confirm
            </button>
          </div>
        </div>
      ) : null}

      {status === "denied" ? (
        <div
          data-testid="tool-call-denied-banner"
          className="flex items-center justify-between px-4 py-2.5"
          style={{ borderTop: "1px solid var(--border)" }}
        >
          <span
            className="inline-flex items-center gap-1.5 text-[11.5px]"
            style={{ color: "var(--text-subtle)" }}
          >
            <ShieldOff size={12} strokeWidth={1.6} aria-hidden />
            Permission denied for {toolCall.name}
          </span>
          <button
            type="button"
            data-testid="tool-call-open-permissions"
            onClick={onPermissionsLink}
            className="text-[11.5px] hover:underline focus:outline-none"
            style={{ color: "var(--accent)" }}
          >
            Open Settings → Permissions
          </button>
        </div>
      ) : null}

      {status !== "confirming" && status !== "denied" ? (
        <div
          className="flex items-center justify-between px-4 py-2.5"
          style={{ borderTop: "1px solid var(--border)" }}
        >
          <span
            data-testid="tool-call-witness-chip"
            className="inline-flex items-center gap-1.5"
            style={{
              height: 22,
              padding: "0 8px 0 7px",
              borderRadius: 999,
              background: witnessVerified
                ? "linear-gradient(180deg, rgba(166,194,176,0.07), rgba(166,194,176,0.03))"
                : "transparent",
              border: `1px solid ${witnessVerified ? "rgba(166,194,176,0.18)" : "var(--border)"}`,
              color: witnessVerified ? "var(--verified)" : "var(--text-subtle)",
              fontSize: 11,
              opacity: witnessVerified ? 1 : 0.55,
            }}
          >
            <KeyRound size={11} strokeWidth={1.6} />
            <span
              style={{
                color: witnessVerified ? "rgba(166,194,176,0.78)" : undefined,
              }}
            >
              {witnessVerified ? "verified" : "awaiting receipt"}
            </span>
            {witnessVerified ? (
              <>
                <span style={{ color: "rgba(166,194,176,0.35)" }}>·</span>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: "#C8DDD0",
                    letterSpacing: "0.01em",
                  }}
                >
                  {witnessHash}
                </span>
              </>
            ) : null}
          </span>
          {witnessVerified ? (
            <button
              type="button"
              data-testid="tool-call-inspect-button"
              onClick={() => setVerifyOpen(true)}
              className="text-[11.5px] inline-flex items-center gap-1 hover:underline focus:outline-none"
              style={{ color: "var(--text-subtle)" }}
            >
              <span>inspect</span>
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 12h14" />
                <path d="m13 5 7 7-7 7" />
              </svg>
            </button>
          ) : (
            <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
              {status === "executing" ? "running…" : ""}
            </span>
          )}
        </div>
      ) : null}

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="body"
            initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, height: "auto" }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={
              reduce ? { duration: 0 } : { duration: 0.18, ease: "easeOut" }
            }
            data-testid="tool-call-body"
            style={{ borderTop: "1px solid var(--border)" }}
          >
            <div className="p-3 space-y-2 text-[11px]">
              <div>
                <span
                  className="block uppercase tracking-wider mb-0.5"
                  style={{ color: "var(--text-faint)" }}
                >
                  input
                </span>
                <pre
                  className="m-0 p-2 rounded-md overflow-auto"
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: "var(--text)",
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                  }}
                >
                  {pretty(toolCall.input)}
                </pre>
              </div>
              <div>
                <span
                  className="block uppercase tracking-wider mb-0.5"
                  style={{ color: "var(--text-faint)" }}
                >
                  output
                </span>
                <pre
                  className="m-0 p-2 rounded-md overflow-auto"
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: "var(--text)",
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                  }}
                >
                  {pretty(toolCall.output)}
                </pre>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <WitnessVerifierModal
        invocationId={verifyOpen ? toolCall.invocationId ?? null : null}
        onOpenChange={(o) => setVerifyOpen(o)}
        testId="tool-call-witness-verifier"
      />
    </motion.div>
  );
}

interface StatusPillProps {
  status: ToolCallStatus;
}

function StatusPill({ status }: StatusPillProps) {
  const config: Record<
    ToolCallStatus,
    { label: string; bg: string; border: string; color: string }
  > = {
    pending: {
      label: "pending",
      bg: "rgba(212,180,122,0.07)",
      border: "rgba(212,180,122,0.20)",
      color: "#E2C58B",
    },
    confirming: {
      label: "requires confirm",
      bg: "rgba(212,180,122,0.07)",
      border: "rgba(212,180,122,0.22)",
      color: "#E2C58B",
    },
    executing: {
      label: "executing",
      bg: "rgba(212,180,122,0.07)",
      border: "rgba(212,180,122,0.20)",
      color: "#E2C58B",
    },
    done: {
      label: "done",
      bg: "rgba(166,194,176,0.06)",
      border: "rgba(166,194,176,0.18)",
      color: "#BFD5C7",
    },
    failed: {
      label: "failed",
      bg: "rgba(208,133,133,0.07)",
      border: "rgba(208,133,133,0.22)",
      color: "#E0A8A8",
    },
    denied: {
      label: "denied",
      bg: "rgba(208,133,133,0.07)",
      border: "rgba(208,133,133,0.22)",
      color: "#E0A8A8",
    },
  };
  const { label, bg, border, color } = config[status];

  return (
    <span
      data-testid={`tool-call-status-${status}`}
      className="inline-flex items-center gap-1.5"
      style={{
        height: 22,
        padding: "0 9px 0 8px",
        borderRadius: 999,
        background: bg,
        border: `1px solid ${border}`,
        color,
        fontSize: 11,
        lineHeight: 1,
        letterSpacing: "0.005em",
      }}
    >
      {status === "pending" || status === "executing" ? (
        <span
          aria-hidden
          className="animate-spin inline-block"
          style={{
            width: 11,
            height: 11,
            borderRadius: 999,
            border: "1.6px solid rgba(212,180,122,0.22)",
            borderTopColor: "#D4B47A",
            borderRightColor: "#D4B47A",
          }}
        />
      ) : null}
      {status === "done" ? (
        <Check size={9} strokeWidth={3} aria-hidden />
      ) : null}
      {status === "confirming" ? (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
          <circle cx="12" cy="12" r="9" />
        </svg>
      ) : null}
      {status === "denied" || status === "failed" ? (
        <X size={9} strokeWidth={3} aria-hidden />
      ) : null}
      {label}
    </span>
  );
}

export function applyOutcomeToStore(
  updateToolCall: (
    messageId: string,
    toolCallId: string,
    patch: Partial<ToolCall>,
  ) => void,
  messageId: string,
  toolCallId: string,
  outcome: InvokeOutcome,
): void {
  switch (outcome.kind) {
    case "output":
      updateToolCall(messageId, toolCallId, {
        status: "done",
        invocationId: outcome.invocation_id,
        output: outcome.output.value,
        permission: outcome.permission,
      });
      break;
    case "requires_confirm":
      updateToolCall(messageId, toolCallId, {
        status: "confirming",
        permission: outcome.permission,
      });
      break;
    case "denied":
      updateToolCall(messageId, toolCallId, {
        status: "denied",
        error: outcome.reason,
      });
      break;
  }
}
