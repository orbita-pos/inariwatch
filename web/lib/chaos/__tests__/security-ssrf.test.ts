/**
 * Security Chaos Test: SSRF Protection
 *
 * Tests URL validation against bypass vectors:
 * - Direct private IPs (127.0.0.1, 10.x, 169.254.x)
 * - Encoded IPs (octal, hex, decimal)
 * - IPv6 variants
 * - Internal TLDs
 * - Protocol smuggling
 * - Unicode/special chars
 */

import { describe, it, expect } from "vitest";
import { isSafeUrl } from "@/lib/services/url-validation";

describe("Security: SSRF Protection", () => {
  // ── Must be BLOCKED ─────────────────────────────────────────────────

  describe("blocks localhost variants", () => {
    const blocked = [
      "http://localhost",
      "http://localhost:3000",
      "http://127.0.0.1",
      "http://127.0.0.1:8080",
      "http://0.0.0.0",
      "http://[::1]",
      "http://[::1]:3000",
    ];
    for (const url of blocked) {
      it(`blocks ${url}`, () => expect(isSafeUrl(url)).toBe(false));
    }
  });

  describe("blocks private IPv4 ranges", () => {
    const blocked = [
      "http://10.0.0.1",
      "http://10.255.255.255",
      "http://172.16.0.1",
      "http://172.31.255.255",
      "http://192.168.0.1",
      "http://192.168.1.100",
      "http://169.254.169.254",         // AWS metadata
      "http://169.254.169.254/latest/meta-data/",
    ];
    for (const url of blocked) {
      it(`blocks ${url}`, () => expect(isSafeUrl(url)).toBe(false));
    }
  });

  describe("blocks encoded IP variants", () => {
    const blocked = [
      "http://0x7f000001",              // hex 127.0.0.1
      "http://017700000001",            // octal 127.0.0.1
      "http://2130706433",              // decimal 127.0.0.1
      "http://0177.0.0.1",             // octal per-octet
      "http://0x7f.0.0.1",             // hex per-octet
      "http://0.0.0.0",
    ];
    for (const url of blocked) {
      it(`blocks ${url}`, () => expect(isSafeUrl(url)).toBe(false));
    }
  });

  describe("blocks IPv6 private ranges", () => {
    const blocked = [
      "http://[::1]",
      "http://[::ffff:127.0.0.1]",     // IPv4-mapped
      "http://[fe80::1]",              // link-local
      "http://[fd00::1]",             // unique local
      "http://[fc00::1]",             // unique local
    ];
    for (const url of blocked) {
      it(`blocks ${url}`, () => expect(isSafeUrl(url)).toBe(false));
    }
  });

  describe("blocks internal TLDs", () => {
    const blocked = [
      "http://app.internal",
      "http://service.local",
      "http://evil.localhost",
      "http://api.service.internal:8080",
    ];
    for (const url of blocked) {
      it(`blocks ${url}`, () => expect(isSafeUrl(url)).toBe(false));
    }
  });

  describe("blocks non-HTTP protocols", () => {
    const blocked = [
      "file:///etc/passwd",
      "ftp://internal.server",
      "gopher://127.0.0.1",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
    ];
    for (const url of blocked) {
      it(`blocks ${url}`, () => expect(isSafeUrl(url)).toBe(false));
    }
  });

  // ── Must be ALLOWED ───────────────────────────────────────────────

  describe("allows legitimate public URLs", () => {
    const allowed = [
      "https://api.example.com",
      "https://app.inariwatch.com",
      "https://google.com",
      "http://status.company.com:8080",
      "https://my-app.vercel.app",
      "https://api.github.com/repos/owner/repo",
    ];
    for (const url of allowed) {
      it(`allows ${url}`, () => expect(isSafeUrl(url)).toBe(true));
    }
  });

  // ── Edge cases ────────────────────────────────────────────────────

  describe("handles edge cases", () => {
    it("rejects empty string", () => expect(isSafeUrl("")).toBe(false));
    it("rejects invalid URL", () => expect(isSafeUrl("not-a-url")).toBe(false));
    it("rejects URL with auth", () => {
      // http://user:pass@internal still gets parsed, host is "internal"
      expect(isSafeUrl("http://user:pass@localhost")).toBe(false);
    });
    it("blocks 172.16-31 but allows 172.32+", () => {
      expect(isSafeUrl("http://172.16.0.1")).toBe(false);
      expect(isSafeUrl("http://172.31.0.1")).toBe(false);
      expect(isSafeUrl("http://172.32.0.1")).toBe(true);
    });
  });

  // ── DNS rebinding awareness ───────────────────────────────────────

  describe("DNS rebinding defense", () => {
    it("isSafeUrl validates at check time (not fetch time)", () => {
      // isSafeUrl only checks the hostname string — it cannot prevent DNS rebinding
      // because the hostname "attacker.com" passes validation (it's a public domain)
      // but at fetch time, DNS can resolve to 127.0.0.1
      //
      // The fix: re-validate URL at fetch time in pollUptime()
      // This test documents the limitation
      expect(isSafeUrl("https://attacker-rebind.example.com")).toBe(true);
      // In production, pollUptime should re-call isSafeUrl before each fetch
    });
  });
});
