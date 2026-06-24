import { Check, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Ambient toast bus — 2026-05-08 design pivot (Frame 2B / 2C).
 *
 * The toast carries the same brand DNA as everything else: dark
 * surface, hairline border, sage check icon, optional witness chip,
 * primary cream "Open" CTA. Stacks bottom-right with the older
 * toasts fading out (opacity descending, scale shrinking).
 *
 * `useToastBus()` exposes `push(payload)` for callers — the agent's
 * post-merge confirmation, the search-completed event, the pairing
 * success moment all pipe through here. Each toast auto-dismisses
 * after `payload.timeoutMs` (default 8 s).
 */

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastPayload {
  id?: string;
  title: ReactNode;
  /** Shown beneath the title — usually a 1-line context. Optional. */
  body?: ReactNode;
  /** Sage `verified · w_xxxxxxxx` chip. Pass to advertise the moat. */
  witnessHash?: string;
  /** Optional CTA — usually "Open PR", "View receipt", etc. */
  action?: ToastAction;
  /** Tone of the title check icon. Sage by default. */
  tone?: "sage" | "neutral";
  /** Auto-dismiss delay in ms. Default 8000. Set 0 for sticky. */
  timeoutMs?: number;
}

interface InternalToast extends ToastPayload {
  id: string;
  /** Wall-clock when the toast entered the queue. Used for ordering. */
  enteredAt: number;
}

interface ToastBusApi {
  push: (payload: ToastPayload) => string;
  dismiss: (id: string) => void;
}

const ToastBusContext = createContext<ToastBusApi | null>(null);

/**
 * Provider — mount once near the root. Exposes `useToastBus()` to any
 * descendant + renders the stacked viewport at the bottom-right.
 */
export function ToastBusProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<InternalToast[]>([]);
  const timersRef = useRef<Map<string, number>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const t = timersRef.current.get(id);
    if (t) {
      window.clearTimeout(t);
      timersRef.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (payload: ToastPayload): string => {
      const id =
        payload.id ?? `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const next: InternalToast = {
        ...payload,
        id,
        enteredAt: Date.now(),
      };
      setToasts((prev) => [...prev, next].slice(-3)); // cap at 3 visible
      const timeout = payload.timeoutMs ?? 8000;
      if (timeout > 0) {
        const handle = window.setTimeout(() => dismiss(id), timeout);
        timersRef.current.set(id, handle);
      }
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((handle) => window.clearTimeout(handle));
      timers.clear();
    };
  }, []);

  const api = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastBusContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastBusContext.Provider>
  );
}

export function useToastBus(): ToastBusApi {
  const ctx = useContext(ToastBusContext);
  if (!ctx) {
    throw new Error("useToastBus must be used inside <ToastBusProvider>");
  }
  return ctx;
}

// ── Viewport + Toast ────────────────────────────────────────────────────────

interface ToastViewportProps {
  toasts: InternalToast[];
  onDismiss: (id: string) => void;
}

function ToastViewport({ toasts, onDismiss }: ToastViewportProps) {
  return (
    <div
      role="region"
      aria-label="Notifications"
      className="fixed bottom-6 right-6 z-[1000] flex flex-col items-end gap-2 pointer-events-none"
      data-testid="toast-viewport"
    >
      {toasts.map((toast, idx) => {
        // Newest is at the bottom of the array; render newest at the
        // BOTTOM of the visual stack (full opacity), older toasts
        // fade upward.
        const distanceFromNewest = toasts.length - 1 - idx;
        const opacity = 1 - distanceFromNewest * 0.18;
        const scale = 1 - distanceFromNewest * 0.015;
        return (
          <Toast
            key={toast.id}
            toast={toast}
            onDismiss={() => onDismiss(toast.id)}
            opacity={Math.max(0.55, opacity)}
            scale={Math.max(0.95, scale)}
          />
        );
      })}
    </div>
  );
}

interface ToastProps {
  toast: InternalToast;
  onDismiss: () => void;
  opacity: number;
  scale: number;
}

function Toast({ toast, onDismiss, opacity, scale }: ToastProps) {
  const tone = toast.tone ?? "sage";
  return (
    <div
      data-testid={`toast-${toast.id}`}
      className="pointer-events-auto relative overflow-hidden"
      style={{
        width: 360,
        background: "var(--surface)",
        border: "1px solid var(--border-strong)",
        borderRadius: 12,
        boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
        opacity,
        transform: `scale(${scale})`,
        transformOrigin: "bottom right",
        transition: "opacity 200ms, transform 200ms",
      }}
    >
      {/* Sage gradient strip on the left edge — auto-dismiss "fuse"
       * cue. Matches the comp's `.toast::before`. */}
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 3,
          background:
            "linear-gradient(to bottom, var(--verified), rgba(166,194,176,0.3))",
        }}
      />
      <div
        className="flex items-center gap-2"
        style={{ padding: "10px 14px 6px 16px" }}
      >
        {tone === "sage" ? (
          <Check
            size={14}
            strokeWidth={2}
            style={{ color: "var(--verified)" }}
            aria-hidden
          />
        ) : null}
        <span
          className="text-[13.5px] flex-1 min-w-0 truncate"
          style={{ color: "var(--text)", fontWeight: 500, letterSpacing: "-0.005em" }}
        >
          {toast.title}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          data-testid={`toast-${toast.id}-dismiss`}
          className="transition-colors hover:text-[var(--text)]"
          style={{ color: "var(--text-dim)", fontSize: 11, padding: 2 }}
        >
          <X size={11} strokeWidth={1.7} />
        </button>
      </div>
      {toast.body ? (
        <div
          className="text-[12px]"
          style={{ padding: "0 14px 10px 16px", color: "var(--text-muted)" }}
        >
          {toast.body}
        </div>
      ) : null}
      {toast.witnessHash || toast.action ? (
        <div
          className="flex items-center"
          style={{
            padding: "8px 14px 10px 16px",
            borderTop: "1px solid var(--border)",
            justifyContent: "space-between",
          }}
        >
          {toast.witnessHash ? (
            <span
              className="inline-flex items-center gap-1.5"
              style={{
                height: 22,
                padding: "0 9px",
                borderRadius: 999,
                border: "1px solid rgba(166,194,176,0.34)",
                color: "var(--verified)",
                fontSize: 11,
                lineHeight: 1,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: 999,
                  background: "var(--verified)",
                }}
              />
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10.5,
                }}
              >
                verified · {toast.witnessHash}
              </span>
            </span>
          ) : (
            <span />
          )}
          {toast.action ? (
            <button
              type="button"
              onClick={toast.action.onClick}
              data-testid={`toast-${toast.id}-action`}
              className="inline-flex items-center gap-1.5 transition-colors hover:bg-white/[0.025]"
              style={{
                height: 22,
                padding: "0 10px",
                borderRadius: 6,
                background: "transparent",
                color: "var(--text-muted)",
                border: "1px solid var(--border-strong)",
                fontSize: 11,
              }}
            >
              {toast.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ──────────── Legacy single-component export shim ────────────
 * Pre-pivot, this module exported `ToastProvider` / `Toast` /
 * `ToastViewport` from Radix. Nothing in the codebase actually
 * imported them, but keeping no-op aliases avoids a hidden
 * dependency surfacing later. */

export const ToastProvider = ToastBusProvider;
export { Toast as ToastCard };
