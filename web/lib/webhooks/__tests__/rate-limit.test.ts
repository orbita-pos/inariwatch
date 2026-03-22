import { describe, it, expect, beforeEach, vi } from "vitest";

const { checkWebhookRateLimit } = await import("@/lib/webhooks/rate-limit");

describe("checkWebhookRateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const IP = "192.168.1.1";

  it("allows requests below the limit", () => {
    const res = checkWebhookRateLimit(IP, 60000, 5);
    expect(res.allowed).toBe(true);
    expect(res.retryAfter).toBeUndefined();
  });

  it("denies requests over the limit and returns retryAfter", () => {
    // Make 2 allowed requests
    checkWebhookRateLimit(IP, 60000, 2);
    checkWebhookRateLimit(IP, 60000, 2);

    // The 3rd request should fail
    const res = checkWebhookRateLimit(IP, 60000, 2);
    
    expect(res.allowed).toBe(false);
    expect(res.retryAfter).toBeGreaterThan(0);
    expect(res.retryAfter).toBeLessThanOrEqual(60);
  });

  it("resets limit after the window expires", () => {
    checkWebhookRateLimit(IP, 60000, 1);
    
    // Window is 60s, advance timer by 61s
    vi.advanceTimersByTime(61000);
    
    const res = checkWebhookRateLimit(IP, 60000, 1);
    expect(res.allowed).toBe(true);
  });

  it("handles different IPs independently", () => {
    checkWebhookRateLimit("ip-A", 60000, 1);
    
    // ip-B should have its own limit
    const resB = checkWebhookRateLimit("ip-B", 60000, 1);
    expect(resB.allowed).toBe(true);

    // ip-A is exhausted
    const resA = checkWebhookRateLimit("ip-A", 60000, 1);
    expect(resA.allowed).toBe(false);
  });

  it("retryAfter returns correct seconds depending on time passed", () => {
    const start = Date.now();
    vi.setSystemTime(start);

    // Exhaust the limit immediately
    checkWebhookRateLimit(IP, 60_000, 1);
    const res1 = checkWebhookRateLimit(IP, 60_000, 1);
    expect(res1.allowed).toBe(false);
    expect(res1.retryAfter).toBe(60);

    // Advance 30 seconds
    vi.setSystemTime(start + 30_000);
    const res2 = checkWebhookRateLimit(IP, 60_000, 1);
    expect(res2.allowed).toBe(false);
    expect(res2.retryAfter).toBe(30);

    // Advance to 59 seconds
    vi.setSystemTime(start + 59_000);
    const res3 = checkWebhookRateLimit(IP, 60_000, 1);
    expect(res3.allowed).toBe(false);
    expect(res3.retryAfter).toBe(1);

    // Advance past window
    vi.setSystemTime(start + 60_000);
    const res4 = checkWebhookRateLimit(IP, 60_000, 1);
    expect(res4.allowed).toBe(true);
  });
});
