import { describe, it, expect } from "vitest";
// Pure helpers live in the SDK — tests import them via relative path so we
// don't have to set up vitest separately inside capture-replay/.
import {
  urlIsDenied,
  contentTypeIsCapturable,
  redactHeaders,
  maskSecretsInJson,
  processBody,
  ABSOLUTE_MAX_BODY_BYTES,
} from "../../../capture-replay/src/network-body";

describe("urlIsDenied", () => {
  it("matches built-in auth/payment patterns", () => {
    expect(urlIsDenied("https://app.com/api/auth/login")).toBe(true);
    expect(urlIsDenied("https://app.com/api/payment/charge")).toBe(true);
    expect(urlIsDenied("https://app.com/oauth/token")).toBe(true);
    expect(urlIsDenied("https://app.com/2fa/verify")).toBe(true);
  });

  it("returns false for unrelated URLs", () => {
    expect(urlIsDenied("https://app.com/api/products")).toBe(false);
    expect(urlIsDenied("https://app.com/orders/123")).toBe(false);
  });

  it("matches customer-supplied patterns case-insensitively", () => {
    expect(urlIsDenied("https://app.com/api/Internal/Whoami", ["/api/internal"])).toBe(true);
    expect(urlIsDenied("https://app.com/api/billing/invoice", ["/api/billing"])).toBe(true);
  });

  it("returns true for empty URL (defensive — never capture nothing)", () => {
    expect(urlIsDenied("")).toBe(true);
  });
});

describe("contentTypeIsCapturable", () => {
  it("allows text-ish formats", () => {
    expect(contentTypeIsCapturable("application/json")).toBe(true);
    expect(contentTypeIsCapturable("application/json; charset=utf-8")).toBe(true);
    expect(contentTypeIsCapturable("text/plain")).toBe(true);
    expect(contentTypeIsCapturable("application/xml")).toBe(true);
    expect(contentTypeIsCapturable("application/x-www-form-urlencoded")).toBe(true);
  });

  it("rejects binary formats", () => {
    expect(contentTypeIsCapturable("image/png")).toBe(false);
    expect(contentTypeIsCapturable("application/pdf")).toBe(false);
    expect(contentTypeIsCapturable("video/mp4")).toBe(false);
    expect(contentTypeIsCapturable("multipart/form-data; boundary=x")).toBe(false);
  });

  it("rejects null/undefined/empty", () => {
    expect(contentTypeIsCapturable(null)).toBe(false);
    expect(contentTypeIsCapturable(undefined)).toBe(false);
    expect(contentTypeIsCapturable("")).toBe(false);
  });
});

describe("redactHeaders", () => {
  it("removes Authorization, Cookie, etc.", () => {
    const out = redactHeaders({
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
      Cookie: "session=abc",
      "X-Api-Key": "top-secret",
      "Cache-Control": "no-cache",
    });
    expect(out).toEqual({
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    });
  });

  it("matches case-insensitively", () => {
    expect(redactHeaders({ AUTHORIZATION: "x", "x-AUTH-token": "y" })).toEqual({});
  });
});

describe("maskSecretsInJson", () => {
  it("masks string values for secret-looking keys", () => {
    expect(maskSecretsInJson({ password: "hunter2", username: "alice" })).toEqual({
      password: "[REDACTED]",
      username: "alice",
    });
  });

  it("recurses into nested objects", () => {
    expect(
      maskSecretsInJson({
        user: { id: 1, apiKey: "k_xyz", profile: { ssn: "111-22-3333" } },
      }),
    ).toEqual({
      user: { id: 1, apiKey: "[REDACTED]", profile: { ssn: "[REDACTED]" } },
    });
  });

  it("recurses into arrays", () => {
    expect(maskSecretsInJson([{ token: "a" }, { token: "b" }])).toEqual([
      { token: "[REDACTED]" },
      { token: "[REDACTED]" },
    ]);
  });

  it("matches keys case-insensitively + by substring", () => {
    expect(maskSecretsInJson({ MyPassword: "x", access_token_v2: "y" })).toEqual({
      MyPassword: "[REDACTED]",
      access_token_v2: "[REDACTED]",
    });
  });

  it("masks numeric secret values too (CVV often arrives as int)", () => {
    expect(maskSecretsInJson({ cvv: 123 })).toEqual({ cvv: "[REDACTED]" });
  });

  it("preserves null/primitive top-level values", () => {
    expect(maskSecretsInJson(null)).toBeNull();
    expect(maskSecretsInJson("hello")).toBe("hello");
    expect(maskSecretsInJson(42)).toBe(42);
  });

  it("caps recursion depth to defend against cycles", () => {
    type Node = { next?: Node };
    const cyclic: Node = {};
    cyclic.next = cyclic;
    // No throw, eventually replaces with sentinel
    const out = maskSecretsInJson(cyclic);
    expect(out).toBeDefined();
  });
});

describe("processBody", () => {
  it("returns null for non-text content types", () => {
    expect(processBody({ raw: "x", contentType: "image/png", maxBytes: 1000 })).toBeNull();
  });

  it("returns null for empty raw", () => {
    expect(processBody({ raw: "", contentType: "application/json", maxBytes: 1000 })).toBeNull();
  });

  it("pretty-prints + masks JSON", () => {
    const out = processBody({
      raw: JSON.stringify({ ok: true, password: "leak" }),
      contentType: "application/json",
      maxBytes: 1000,
    });
    expect(out).not.toBeNull();
    expect(out!.text).toContain('"password": "[REDACTED]"');
    expect(out!.text).toContain('"ok": true');
    expect(out!.truncated).toBe(false);
  });

  it("truncates over the cap", () => {
    const big = "x".repeat(2000);
    const out = processBody({ raw: big, contentType: "text/plain", maxBytes: 100 });
    expect(out).not.toBeNull();
    expect(out!.text.length).toBe(100);
    expect(out!.truncated).toBe(true);
    expect(out!.originalBytes).toBe(2000);
  });

  it("falls back to raw text when JSON parse fails (truncated mid-string)", () => {
    const out = processBody({
      raw: '{"foo":"bar","trunca',
      contentType: "application/json",
      maxBytes: 1000,
    });
    expect(out).not.toBeNull();
    expect(out!.text).toBe('{"foo":"bar","trunca');
  });

  it("clamps maxBytes to ABSOLUTE_MAX_BODY_BYTES", () => {
    const huge = "y".repeat(ABSOLUTE_MAX_BODY_BYTES + 1000);
    const out = processBody({ raw: huge, contentType: "text/plain", maxBytes: 10_000_000 });
    expect(out!.text.length).toBe(ABSOLUTE_MAX_BODY_BYTES);
    expect(out!.truncated).toBe(true);
  });
});
