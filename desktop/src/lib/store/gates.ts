/**
 * Gate-runner store for Inari Live Mode 5 (`GateRunning`).
 *
 * Holds the in-flight verdict for the active pre-push gate run. The
 * dock subscribes to `daemon:event` and dispatches into this store
 * via the listener installed by `DockShell.tsx`. Mode 5 mounts /
 * unmounts based on `activeRunId !== null`.
 *
 * Persistence: in-memory only. The Rust daemon owns the audit trail
 * (`gate_runs` table); the dock's view of "what's currently running"
 * is ephemeral by design — closing/reopening the dock mid-run shows
 * the latest verdict via `getRecentGateRuns` rather than replaying
 * the partial state.
 */

import { create } from "zustand";

export type GateState = "pending" | "running" | "passed" | "failed" | "deferred";

export interface GateEntry {
  name: string;
  state: GateState;
  /** Optional reason — populated on `failed` / `deferred`. */
  reason?: string;
  /** Latency in ms when state ∈ {passed, failed, deferred}. */
  latencyMs?: number;
}

export interface GatesStore {
  /** Run id assigned by the runner; `null` when no run is active. */
  activeRunId: string | null;
  /** Repo id the run is evaluating. */
  repoId: string | null;
  /** Per-gate entries in canonical order (self_review → substrate_simulate → security_scan). */
  gates: GateEntry[];
  /** Final verdict — `null` while the run is still in flight. */
  allowed: boolean | null;
  /** List of gate names that voted false on completion. */
  blockingGates: string[];
  /** Total wall-clock once the run completes. */
  totalLatencyMs: number | null;

  /** Lifecycle hooks dispatched by the daemon-event listener. */
  startRun: (input: { runId: string; repoId: string; gates: string[] }) => void;
  updateGate: (input: {
    runId: string;
    gate: string;
    state: GateState;
    reason?: string;
    latencyMs: number;
  }) => void;
  completeRun: (input: {
    runId: string;
    allowed: boolean;
    blockingGates: string[];
    totalLatencyMs: number;
  }) => void;
  /** Clear the slot back to idle. Mode 5 unmounts when this fires. */
  clear: () => void;
}

export const useGates = create<GatesStore>((set) => ({
  activeRunId: null,
  repoId: null,
  gates: [],
  allowed: null,
  blockingGates: [],
  totalLatencyMs: null,

  startRun: ({ runId, repoId, gates }) => {
    set({
      activeRunId: runId,
      repoId,
      gates: gates.map((name) => ({ name, state: "pending" as const })),
      allowed: null,
      blockingGates: [],
      totalLatencyMs: null,
    });
  },

  updateGate: ({ runId, gate, state, reason, latencyMs }) => {
    set((s) => {
      // Stale event from a previous run — ignore so the UI doesn't
      // mutate a finished run's gate row out from under the user.
      if (s.activeRunId !== runId) return s;
      return {
        gates: s.gates.map((g) =>
          g.name === gate ? { ...g, state, reason, latencyMs } : g,
        ),
      };
    });
  },

  completeRun: ({ runId, allowed, blockingGates, totalLatencyMs }) => {
    set((s) => {
      if (s.activeRunId !== runId) return s;
      return {
        allowed,
        blockingGates,
        totalLatencyMs,
      };
    });
  },

  clear: () => {
    set({
      activeRunId: null,
      repoId: null,
      gates: [],
      allowed: null,
      blockingGates: [],
      totalLatencyMs: null,
    });
  },
}));

/** Test-only reset. Mirrors `__resetChatStoreForTests` from chat.ts. */
export function __resetGatesStoreForTests(): void {
  useGates.setState({
    activeRunId: null,
    repoId: null,
    gates: [],
    allowed: null,
    blockingGates: [],
    totalLatencyMs: null,
  });
}
