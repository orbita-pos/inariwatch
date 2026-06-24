import { describe, it, expect, vi } from "vitest";

// Mock the DB-backed rate limiter
const mockRateLimit = vi.fn();
vi.mock("@/lib/auth-rate-limit", () => ({
  rateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));

const { checkWebhookRateLimit } = await import("@/lib/webhooks/rate-limit");

describe("checkWebhookRateLimit", () => {
  const IP = "192.168.1.1";

  it("allows requests when rate limit permits", async () => {
    mockRateLimit.mockResolvedValue({ allowed: true });

    const res = await checkWebhookRateLimit(IP);
    expect(res.allowed).toBe(true);
    expect(res.retryAfter).toBeUndefined();
    expect(mockRateLimit).toHaveBeenCalledWith("webhook", IP, { windowMs: 60_000, max: 60 });
  });

  it("denies requests over the limit and returns retryAfter", async () => {
    mockRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });

    const res = await checkWebhookRateLimit(IP);
    expect(res.allowed).toBe(false);
    expect(res.retryAfter).toBe(30);
  });

  it("passes custom window and max to underlying limiter", async () => {
    mockRateLimit.mockResolvedValue({ allowed: true });

    await checkWebhookRateLimit(IP, 120_000, 100);
    expect(mockRateLimit).toHaveBeenCalledWith("webhook", IP, { windowMs: 120_000, max: 100 });
  });

  it("handles different IPs independently", async () => {
    mockRateLimit.mockResolvedValue({ allowed: true });

    await checkWebhookRateLimit("ip-A");
    await checkWebhookRateLimit("ip-B");

    expect(mockRateLimit).toHaveBeenCalledWith("webhook", "ip-A", expect.any(Object));
    expect(mockRateLimit).toHaveBeenCalledWith("webhook", "ip-B", expect.any(Object));
  });
});
