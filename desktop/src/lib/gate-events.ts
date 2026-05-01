/**
 * Pre-push gate runner event bridge (Sesión 20).
 *
 * Subscribes to `daemon:event` and routes the three new variants
 * (`gate_run_started`, `gate_progress`, `gate_run_completed`) into
 * the gates store. Also auto-transitions the dock into Mode 5 on
 * `gate_run_started` — first dock surface that opens via daemon-push
 * instead of explicit user action.
 *
 * jsdom fallback: returns a no-op unlisten when Tauri isn't available
 * so vitest renders don't try to attach to the real bridge.
 */

import type { UnlistenFn } from "@tauri-apps/api/event";

import { onDaemonEvent } from "@/lib/ipc";
import { useChat } from "@/lib/store/chat";
import { useGates, type GateState } from "@/lib/store/gates";

interface GateRunStartedEvent {
  kind: "gate_run_started";
  run_id: string;
  repo_id: string;
  gates: string[];
}

interface GateProgressEvent {
  kind: "gate_progress";
  run_id: string;
  gate: string;
  state: string;
  reason?: string | null;
  latency_ms: number;
}

interface GateRunCompletedEvent {
  kind: "gate_run_completed";
  run_id: string;
  allowed: boolean;
  blocking_gates: string[];
  total_latency_ms: number;
}

function normalizeGateState(raw: string): GateState {
  switch (raw) {
    case "running":
    case "passed":
    case "failed":
    case "deferred":
    case "pending":
      return raw;
    default:
      return "pending";
  }
}

/**
 * Install the daemon-event listener for gate-runner variants. Returns
 * an `unlisten` the caller MUST invoke on unmount.
 */
export async function installGateRunListener(): Promise<UnlistenFn> {
  const tauriAvailable =
    typeof window !== "undefined" && "__TAURI__" in window;
  if (!tauriAvailable) {
    return () => {
      /* no-op for jsdom */
    };
  }

  return await onDaemonEvent((event) => {
    if (typeof event !== "object" || event === null) return;
    const kind = (event as { kind?: unknown }).kind;
    if (typeof kind !== "string") return;

    if (kind === "gate_run_started") {
      const e = event as unknown as GateRunStartedEvent;
      useGates.getState().startRun({
        runId: e.run_id,
        repoId: e.repo_id,
        gates: Array.isArray(e.gates) ? e.gates : [],
      });
      // Auto-transition into Mode 5. The user can dismiss back to
      // idle from the verdict footer.
      useChat.getState().setMode("gates");
      return;
    }

    if (kind === "gate_progress") {
      const e = event as unknown as GateProgressEvent;
      useGates.getState().updateGate({
        runId: e.run_id,
        gate: e.gate,
        state: normalizeGateState(e.state),
        reason: e.reason ?? undefined,
        latencyMs: typeof e.latency_ms === "number" ? e.latency_ms : 0,
      });
      return;
    }

    if (kind === "gate_run_completed") {
      const e = event as unknown as GateRunCompletedEvent;
      useGates.getState().completeRun({
        runId: e.run_id,
        allowed: e.allowed,
        blockingGates: Array.isArray(e.blocking_gates) ? e.blocking_gates : [],
        totalLatencyMs:
          typeof e.total_latency_ms === "number" ? e.total_latency_ms : 0,
      });
      return;
    }

    // gate_bypass_used is intentionally not surfaced here — the bypass
    // flow already updates the dock state via the user's click.
  });
}
