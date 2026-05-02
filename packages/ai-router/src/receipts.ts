// EAP receipt emission. Per INARI_AI_ARCHITECTURE.md §12 (LOCKED 2026-05-02).
//
// Phase 1 emits metadata-only receipts (no Ed25519 signature yet). Sinks are
// registered by surfaces — web wires a sink that persists to InariLens and
// the eap_receipts mirror; desktop wires a sink that signs with the user's
// local Ed25519 key (S2).
//
// Receipt emission is fire-and-forget. Sink errors NEVER bubble into the
// dispatch path — receipts are observability, not correctness.

import type { Substrate } from "./rules";
import type { TaskName, TaskNamespace } from "./tasks";

export interface RouterReceipt {
  task: TaskName;
  namespace: TaskNamespace;
  substrate: Substrate;
  provider: string;
  model: string;
  tsStart: number;
  tsEnd: number;
  workspaceId?: string;
  userId?: string;
  projectId?: string;
  alertId?: string;
  remediationSessionId?: string;
  isPlatformKey: boolean;
  fallbackUsed: boolean;
  /**
   * Optional payload + response hash slots. Phase 1 leaves these unset; web
   * wiring may compute a SHA-256 of the prompt body when persisting.
   */
  payloadHash?: string;
  responseHash?: string;
  /** "direct" when same-process, "relay" when via relay.inariwatch.com (S2+). */
  relayPath?: "direct" | "relay";
  /** Hex-encoded Ed25519 signature (Phase 4+). */
  signature?: string;
  /**
   * v0.3 S2 — when the dispatch ran on user-sidecar, the sidecar signs
   * its own receipt locally (S27/S28 chain) and the relay forwards it
   * back to web. Web's sink persists this AS-IS without re-signing —
   * the user's key is the source of truth for substrate=user-sidecar.
   * For cloud / capture-embedded / cli-linked dispatches this stays
   * undefined and web's sink signs with the cloud key.
   */
  userSidecarReceipt?: unknown;
}

export type ReceiptSink = (receipt: RouterReceipt) => void | Promise<void>;

const sinks: ReceiptSink[] = [];

/**
 * Register a sink. Multiple sinks may be registered; each is called per
 * dispatch. Order is preserved.
 *
 * Idempotent — registering the same function reference twice is a no-op,
 * which keeps Next.js HMR / Vitest module reloads from double-firing.
 */
export function registerReceiptSink(sink: ReceiptSink): void {
  if (sinks.includes(sink)) return;
  sinks.push(sink);
}

/** Visible for tests — unregister all sinks. Not for runtime use. */
export function clearReceiptSinks(): void {
  sinks.length = 0;
}

/** Visible for tests — current sink count. */
export function receiptSinkCount(): number {
  return sinks.length;
}

/**
 * Fire-and-forget receipt emission. Sinks may run async work; we never
 * await any of them. Sink failures are swallowed by design.
 */
export function emitReceipt(receipt: RouterReceipt): void {
  for (const sink of sinks) {
    try {
      const r = sink(receipt);
      if (r && typeof (r as Promise<void>).catch === "function") {
        (r as Promise<void>).catch(() => {});
      }
    } catch {
      // Receipts must never break the dispatch path.
    }
  }
}
