/**
 * DB-backed rate limiter for webhook endpoints.
 * Delegates to the shared auth-rate-limit module so limits persist
 * across serverless instances and deployments.
 */

import { rateLimit } from "@/lib/auth-rate-limit";

const DEFAULT_WINDOW_MS = 60_000; // 60 seconds
const DEFAULT_MAX_REQUESTS = 60; // per window

/**
 * Check whether a webhook request from `ip` should be allowed.
 *
 * @param ip            The client IP address (or "unknown")
 * @param windowMs      Sliding window duration in milliseconds (default 60 000)
 * @param maxRequests   Maximum requests allowed within the window (default 60)
 * @returns `{ allowed: true }` or `{ allowed: false, retryAfter }` where
 *          `retryAfter` is the number of seconds until the window resets.
 */
/**
 * Extract the real client IP from request headers.
 * Uses x-real-ip (set by Vercel, cannot be spoofed) with fallback
 * to rightmost x-forwarded-for (added by trusted proxy).
 */
export function extractClientIp(req: Request): string {
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();

  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    return parts[parts.length - 1] || "unknown";
  }

  return "unknown";
}

export async function checkWebhookRateLimit(
  ip: string,
  windowMs: number = DEFAULT_WINDOW_MS,
  maxRequests: number = DEFAULT_MAX_REQUESTS
): Promise<{ allowed: boolean; retryAfter?: number }> {
  const result = await rateLimit("webhook", ip, { windowMs, max: maxRequests });
  return {
    allowed: result.allowed,
    retryAfter: result.retryAfterSeconds,
  };
}
