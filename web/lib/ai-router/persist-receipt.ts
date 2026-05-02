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

import { db, aiRouterReceipts } from "@/lib/db";
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
  const usage = inferUsage(receipt);
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
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    durationMs: Math.max(0, receipt.tsEnd - receipt.tsStart),
    relayPath: receipt.relayPath ?? null,
    fallbackUsed: receipt.fallbackUsed,
    isPlatformKey: receipt.isPlatformKey,
    eapChainRoot: null,
    userSidecarReceipt: receipt.userSidecarReceipt ?? null,
    cloudReceipt: null,
  });
}

interface UsageBag {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
}

/**
 * RouterReceipt today doesn't carry token usage on the receipt itself —
 * usage lives on the response shape. Until S3 plumbs it onto the receipt,
 * we leave the columns null and let /admin/ops display a "—" until the
 * column is populated by a future migration backfill.
 */
function inferUsage(_receipt: RouterReceipt): UsageBag {
  return {
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
  };
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
