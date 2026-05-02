// v0.3 S2.5 — durable sink for @inariwatch/ai-router RouterReceipt events.
//
// Phase 1 (S1) only had an in-memory sink. This sink persists to the
// `ai_router_receipts` table (migration 0076) so /admin/ops widgets and
// post-hoc audits can query the dispatch breakdown without a separate
// telemetry pipeline. Per architecture §12 every receipt is the verifiable
// trail of one AI action; we keep both signed payloads (cloud + sidecar)
// alongside the metadata for chain replays.
//
// Sink contract (`packages/ai-router/src/receipts.ts`):
//   - Fire-and-forget. We never throw — receipt failures must not block
//     the dispatch path.
//   - Idempotent registration. The router's `registerReceiptSink` skips
//     duplicate function references, so re-importing this module across
//     HMR / vitest reloads is safe.

import {
  registerReceiptSink,
  type RouterReceipt,
} from "@inariwatch/ai-router";

let registered = false;

export function persistRouterReceipt(receipt: RouterReceipt): void {
  // Schedule the insert — never await. Sinks are fire-and-forget per the
  // router contract.
  void doInsert(receipt).catch(() => {
    // Receipts are observability, not correctness. Swallow.
  });
}

async function doInsert(receipt: RouterReceipt): Promise<void> {
  // Lazy import: lib/db throws synchronously at module-load when DATABASE_URL
  // is unset. Resolving the handle here means callers like web/lib/ai/client.ts
  // can import persist-receipt unconditionally — the dispatch path only hits
  // the DB when a real receipt actually fires.
  const { db, aiRouterReceipts } = await import("@/lib/db");
  await db.insert(aiRouterReceipts).values({
    workspaceId: receipt.workspaceId ?? null,
    userId: receipt.userId ?? null,
    projectId: receipt.projectId ?? null,
    alertId: receipt.alertId ?? null,
    remediationSessionId: receipt.remediationSessionId ?? null,
    task: receipt.task,
    namespace: receipt.namespace,
    substrate: receipt.substrate,
    provider: String(receipt.provider),
    model: receipt.model,
    // v0.3 S3 — usage now arrives on the receipt directly. dispatch() coerces
    // zeros to null upstream so /admin/ops shows "no data" instead of "0
    // tokens" for providers that didn't surface usage (sidecar stub, voice
    // TTS, etc.).
    inputTokens: receipt.inputTokens ?? null,
    outputTokens: receipt.outputTokens ?? null,
    cachedInputTokens: receipt.cachedInputTokens ?? null,
    durationMs: Math.max(0, receipt.tsEnd - receipt.tsStart),
    relayPath: receipt.relayPath ?? null,
    fallbackUsed: receipt.fallbackUsed,
    isPlatformKey: receipt.isPlatformKey,
    eapChainRoot: null,
    userSidecarReceipt: receipt.userSidecarReceipt ?? null,
    cloudReceipt: null,
  });
}

/**
 * Register the persist sink with the router. Called once at boot from
 * `web/lib/ai/client.ts` (and re-imports are no-ops thanks to the router's
 * idempotent registration).
 */
export function ensureReceiptSinkRegistered(): void {
  if (registered) return;
  registerReceiptSink(persistRouterReceipt);
  registered = true;
}
