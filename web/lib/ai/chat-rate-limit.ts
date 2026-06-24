/**
 * Per-user chat rate limiting — two layers:
 *
 *  1. Burst  — sliding fixed-window via Redis INCR.
 *              Platform-funded: 5 msgs / 60 s.
 *              BYOK: 10 msgs / 60 s (they pay their own API costs).
 *
 *  2. Daily  — platform-funded only: 50 msgs / UTC day.
 *              BYOK users have no daily cap.
 *
 * Fail-open when Redis is unavailable: the monthly quota in the DB is
 * the backstop. We never drop a real user because our infra is flaky.
 */

import { getRedis } from "@/lib/redis";

const BURST_WINDOW_SEC = 60;
const BURST_LIMIT_PLATFORM = 5;
const BURST_LIMIT_BYOK = 10;
const DAILY_LIMIT_PLATFORM = 50;

export type ChatRateLimitResult =
  | { ok: true }
  | { ok: false; reason: "burst" | "daily" };

export async function checkChatRateLimit(
  userId: string,
  isPlatformKey: boolean,
): Promise<ChatRateLimitResult> {
  const r = getRedis();
  if (!r) return { ok: true };

  try {
    const minuteBucket = Math.floor(Date.now() / (BURST_WINDOW_SEC * 1_000));
    const burstKey = `rl:chat:burst:${userId}:${minuteBucket}`;
    const burstLimit = isPlatformKey ? BURST_LIMIT_PLATFORM : BURST_LIMIT_BYOK;

    const burst = await r.incr(burstKey);
    // Set TTL only on the first increment — subsequent calls skip the round-trip.
    if (burst === 1) await r.expire(burstKey, BURST_WINDOW_SEC + 5);

    if (burst > burstLimit) return { ok: false, reason: "burst" };

    if (isPlatformKey) {
      const today = new Date().toISOString().slice(0, 10);
      const dayKey = `rl:chat:daily:${userId}:${today}`;
      const daily = await r.incr(dayKey);
      if (daily === 1) await r.expire(dayKey, 90_000); // 25 h — implicit daily reset via key suffix
      if (daily > DAILY_LIMIT_PLATFORM) return { ok: false, reason: "daily" };
    }

    return { ok: true };
  } catch {
    // Redis hiccup — fail-open. Monthly quota is the safety net.
    return { ok: true };
  }
}
