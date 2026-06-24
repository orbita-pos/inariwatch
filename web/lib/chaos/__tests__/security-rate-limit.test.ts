/**
 * Security Chaos Test: Rate Limit Bypass via IP Spoofing
 *
 * Tests that rate limiting cannot be bypassed by manipulating
 * X-Forwarded-For headers.
 */

import { describe, it, expect } from "vitest";

/**
 * Extract client IP from request headers.
 * This is the function that all webhook routes SHOULD use.
 *
 * On Vercel: x-real-ip is set by the platform (cannot be spoofed).
 * Fallback to rightmost x-forwarded-for (last proxy = Vercel).
 */
function extractClientIp(headers: { get(name: string): string | null }): string {
  // Prefer x-real-ip (Vercel sets this, cannot be spoofed by client)
  const realIp = headers.get("x-real-ip");
  if (realIp) return realIp.trim();

  // Fallback: rightmost x-forwarded-for (last entry = closest trusted proxy)
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    // Rightmost is the one added by the trusted proxy (Vercel)
    return parts[parts.length - 1] || "unknown";
  }

  return "unknown";
}

describe("Security: Rate Limit IP Extraction", () => {
  // ── Current vulnerable pattern ──────────────────────────────────────

  describe("vulnerable pattern: leftmost x-forwarded-for", () => {
    function vulnerableExtract(headers: { get(name: string): string | null }): string {
      return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    }

    it("attacker can spoof IP by prepending to x-forwarded-for", () => {
      // Attacker sends: X-Forwarded-For: fake-1.2.3.4
      // Vercel appends: X-Forwarded-For: fake-1.2.3.4, real-5.6.7.8
      const headers = new Map([["x-forwarded-for", "fake-1.2.3.4, real-5.6.7.8"]]);
      const ip = vulnerableExtract({ get: (k) => headers.get(k) ?? null });
      expect(ip).toBe("fake-1.2.3.4"); // SPOOFED — attacker controls rate limit key
    });

    it("attacker can rotate IPs to bypass rate limit", () => {
      const ips = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const headers = new Map([["x-forwarded-for", `${i}.${i}.${i}.${i}, real-5.6.7.8`]]);
        ips.add(vulnerableExtract({ get: (k) => headers.get(k) ?? null }));
      }
      // 100 unique IPs = 100 × 60 req/min = 6000 req/min (vs limit of 60)
      expect(ips.size).toBe(100);
    });
  });

  // ── Fixed pattern: x-real-ip or rightmost xff ───────────────────────

  describe("fixed pattern: extractClientIp", () => {
    it("uses x-real-ip when available (Vercel platform header)", () => {
      const headers = new Map([
        ["x-real-ip", "5.6.7.8"],
        ["x-forwarded-for", "fake-1.2.3.4, 5.6.7.8"],
      ]);
      const ip = extractClientIp({ get: (k) => headers.get(k) ?? null });
      expect(ip).toBe("5.6.7.8"); // Real IP, not spoofed
    });

    it("falls back to rightmost x-forwarded-for", () => {
      const headers = new Map([
        ["x-forwarded-for", "fake-1.2.3.4, real-5.6.7.8"],
      ]);
      const ip = extractClientIp({ get: (k) => headers.get(k) ?? null });
      expect(ip).toBe("real-5.6.7.8"); // Rightmost = trusted proxy added
    });

    it("attacker cannot rotate IPs with x-real-ip", () => {
      const ips = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const headers = new Map([
          ["x-real-ip", "5.6.7.8"], // Vercel always sets the real IP
          ["x-forwarded-for", `${i}.${i}.${i}.${i}, 5.6.7.8`],
        ]);
        ips.add(extractClientIp({ get: (k) => headers.get(k) ?? null }));
      }
      expect(ips.size).toBe(1); // Always the same real IP
      expect(ips.has("5.6.7.8")).toBe(true);
    });

    it("returns unknown when no IP headers present", () => {
      const headers = new Map<string, string>();
      const ip = extractClientIp({ get: (k) => headers.get(k) ?? null });
      expect(ip).toBe("unknown");
    });

    it("handles single IP in x-forwarded-for", () => {
      const headers = new Map([["x-forwarded-for", "1.2.3.4"]]);
      const ip = extractClientIp({ get: (k) => headers.get(k) ?? null });
      expect(ip).toBe("1.2.3.4");
    });

    it("trims whitespace in headers", () => {
      const headers = new Map([["x-real-ip", "  1.2.3.4  "]]);
      const ip = extractClientIp({ get: (k) => headers.get(k) ?? null });
      expect(ip).toBe("1.2.3.4");
    });
  });
});
