/**
 * Fase 4 — CI webhook listener.
 *
 * Replaces the 15s-interval poll loop in `web/lib/ai/remediate.ts` with a
 * Redis pub/sub subscription that wakes the remediation the moment GitHub
 * fires `check_run.completed`. The webhook handler at
 * `web/app/api/webhooks/github-check-run/[integrationId]/route.ts` publishes
 * to `remediation:<sessionId>:ci` after verifying the request signature.
 *
 * This module is the consumer side: the remediation registers the
 * sessionId → head_sha mapping (so the webhook can route back) and awaits a
 * wake signal with a 10-minute timeout. Callers MUST treat the wake as a
 * hint only — the webhook payload is not trusted as authoritative. After
 * a wake, remediate.ts calls `gh.getCheckRunsStatus()` via the real GitHub
 * API to confirm the conclusion before merging/escalating.
 *
 * Availability: this module degrades cleanly. When Redis is unreachable,
 * every exported function returns a result that tells the caller to fall
 * back to the existing polling path. No remediation can get stuck on a
 * listener that never fires.
 *
 * Flag-gated: isCiWebhookEnabled() is the umbrella that callers check. The
 * registration + listener functions are callable even when the flag is off,
 * but the caller is expected to skip them for predictability.
 */

import { getIoredisClient } from "@/lib/redis";

/** Sentinel TTL for the sha→session map, in seconds. CI usually finishes
 *  well within 10 min; we grant 20 so a slow CI can't silently detach. */
const SHA_MAP_TTL_SEC = 20 * 60;

/** Default wall-clock the listener will wait. Chosen to match the spec's
 *  "no remediation stuck waiting > 11 min on CI" acceptance criterion. */
export const CI_WEBHOOK_TIMEOUT_MS = 10 * 60 * 1000;

/** Canonical Redis keys. Exported so the webhook handler uses the same
 *  constants and drift between writer and reader is a compile-time error. */
export function shaMapKey(headSha: string): string {
  return `ci:sha:${headSha}`;
}
export function sessionChannel(sessionId: string): string {
  return `remediation:${sessionId}:ci`;
}

export function isCiWebhookEnabled(): boolean {
  return process.env.CI_WEBHOOK_MODE === "true";
}

/**
 * Structured payload published to the session's CI channel. The conclusion
 * mirrors GitHub's check_run.conclusion enum — callers should treat any
 * value other than "success" as a reason to re-verify via GitHub API
 * before proceeding.
 */
export interface CiWebhookPayload {
  conclusion: string;
  headSha: string;
  deliveryId: string | null;
  checkRunId: number | null;
  receivedAt: number;
}

/**
 * Register `headSha → sessionId` in Redis so the webhook handler can route
 * the check_run.completed back to the waiting remediation. Safe to call
 * repeatedly (simple SET with EX). Returns false on Redis-unavailable; the
 * caller should NOT treat this as fatal — the remediation falls back to
 * polling.
 */
export async function registerCiSession(
  sessionId: string,
  headSha: string,
): Promise<boolean> {
  const client = getIoredisClient();
  if (!client) return false;
  try {
    await client.set(shaMapKey(headSha), sessionId, "EX", SHA_MAP_TTL_SEC);
    return true;
  } catch (err) {
    console.warn(
      "[ci-webhook] registerCiSession failed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Remove the sha→session map. Called after the remediation moves past the
 * CI-waiting state so stale entries don't accumulate. Non-critical — a
 * stale entry just means a late webhook publishes to a dead channel.
 */
export async function unregisterCiSession(headSha: string): Promise<void> {
  const client = getIoredisClient();
  if (!client) return;
  try {
    await client.del(shaMapKey(headSha));
  } catch {
    // Non-blocking — 20min TTL cleans it up anyway.
  }
}

export type WaitCiResult =
  | { result: "fired"; payload: CiWebhookPayload }
  | { result: "timeout" }
  | { result: "unavailable" };

/**
 * Await a single publish on the session's CI channel, or time out after
 * `timeoutMs`. Returns "unavailable" immediately when Redis is down so the
 * caller can skip the webhook path and keep polling.
 *
 * Subscriber uses a dedicated connection (duplicate) so it doesn't block
 * other Redis commands on the shared singleton client.
 */
export async function waitForCiWebhook(
  sessionId: string,
  timeoutMs: number = CI_WEBHOOK_TIMEOUT_MS,
): Promise<WaitCiResult> {
  const sharedClient = getIoredisClient();
  if (!sharedClient) return { result: "unavailable" };

  const subscriber = sharedClient.duplicate();
  const channel = sessionChannel(sessionId);

  try {
    return await new Promise<WaitCiResult>((resolve) => {
      const timer = setTimeout(() => finish({ result: "timeout" }), timeoutMs);
      let done = false;

      const finish = (outcome: WaitCiResult): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        // Best-effort cleanup — a stuck unsubscribe would leak the
        // connection, so wrap in try/catch and force-quit after.
        subscriber.unsubscribe(channel).catch(() => {});
        subscriber.quit().catch(() => {});
        resolve(outcome);
      };

      subscriber.on("message", (ch, raw) => {
        if (ch !== channel) return;
        try {
          const payload = JSON.parse(raw) as CiWebhookPayload;
          if (typeof payload.conclusion !== "string") {
            // Malformed publish — ignore and keep listening. If the
            // timeout fires, caller falls back to polling.
            return;
          }
          finish({ result: "fired", payload });
        } catch {
          // Malformed publish — ignore and keep listening.
        }
      });

      subscriber.on("error", (err) => {
        // Connection lost mid-subscribe — surface as "unavailable" so the
        // caller falls back to polling instead of waiting the full 10min.
        console.warn("[ci-webhook] subscriber error:", err.message);
        finish({ result: "unavailable" });
      });

      subscriber.subscribe(channel).catch((err) => {
        console.warn("[ci-webhook] subscribe failed:", err instanceof Error ? err.message : err);
        finish({ result: "unavailable" });
      });
    });
  } catch (err) {
    console.warn(
      "[ci-webhook] waitForCiWebhook unexpected error:",
      err instanceof Error ? err.message : err,
    );
    return { result: "unavailable" };
  }
}

/**
 * Writer-side helper for the webhook route. Resolves head_sha to a session
 * id and publishes a normalized payload to the session channel. Returns
 * the number of subscribers that received the message, or null when Redis
 * is unavailable / no session was registered for this sha.
 */
export async function publishCiCompletion(
  headSha: string,
  payload: Omit<CiWebhookPayload, "headSha" | "receivedAt">,
): Promise<{ sessionId: string; subscribers: number } | null> {
  const client = getIoredisClient();
  if (!client) return null;
  try {
    const sessionId = await client.get(shaMapKey(headSha));
    if (!sessionId) return null;
    const fullPayload: CiWebhookPayload = {
      ...payload,
      headSha,
      receivedAt: Date.now(),
    };
    const subscribers = await client.publish(
      sessionChannel(sessionId),
      JSON.stringify(fullPayload),
    );
    return { sessionId, subscribers };
  } catch (err) {
    console.warn(
      "[ci-webhook] publishCiCompletion failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
