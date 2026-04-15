import { describe, it, expect } from "vitest";
import {
  validateIngestBody,
  extractClickSelectors,
  extractUrls,
  extractErrorFingerprints,
} from "../helpers";

describe("validateIngestBody", () => {
  const validBody = {
    sessionId: "s_abc123",
    projectId: "550e8400-e29b-41d4-a716-446655440000",
    blockIndex: 0,
    startMs: 0,
    endMs: 30_000,
    events: [{ type: 1 }],
  };

  it("accepts a valid body", () => {
    expect(validateIngestBody(validBody)).toBeNull();
  });

  it("rejects null / non-object", () => {
    expect(validateIngestBody(null)).toBe("Invalid body");
    expect(validateIngestBody("string")).toBe("Invalid body");
    expect(validateIngestBody(42)).toBe("Invalid body");
  });

  it("rejects missing or invalid sessionId", () => {
    expect(validateIngestBody({ ...validBody, sessionId: undefined })).toMatch(/Invalid sessionId/);
    expect(validateIngestBody({ ...validBody, sessionId: "" })).toMatch(/Invalid sessionId/);
    expect(validateIngestBody({ ...validBody, sessionId: "x".repeat(129) })).toMatch(/Invalid sessionId/);
    // No s_ prefix → reject (blocks attackers using arbitrary string keys)
    expect(validateIngestBody({ ...validBody, sessionId: "abc123def" })).toMatch(/Invalid sessionId/);
    // Path-traversal / slashes → reject
    expect(validateIngestBody({ ...validBody, sessionId: "s_../evil" })).toMatch(/Invalid sessionId/);
    // Too short → reject (low entropy)
    expect(validateIngestBody({ ...validBody, sessionId: "s_ab" })).toMatch(/Invalid sessionId/);
  });

  it("accepts a realistic SDK sessionId", () => {
    expect(validateIngestBody({ ...validBody, sessionId: "s_550e8400e29b41d4a716446655440000" })).toBeNull();
    expect(validateIngestBody({ ...validBody, sessionId: "s_abc-123_DEF" })).toBeNull();
  });

  it("rejects non-UUID projectId", () => {
    expect(validateIngestBody({ ...validBody, projectId: "not-a-uuid" })).toMatch(/Invalid projectId/);
    expect(validateIngestBody({ ...validBody, projectId: "" })).toMatch(/Invalid projectId/);
    expect(validateIngestBody({ ...validBody, projectId: 123 })).toMatch(/Invalid projectId/);
  });

  it("accepts valid UUID v4", () => {
    expect(validateIngestBody({ ...validBody, projectId: "550e8400-e29b-41d4-a716-446655440000" })).toBeNull();
  });

  it("rejects negative or non-integer blockIndex", () => {
    expect(validateIngestBody({ ...validBody, blockIndex: -1 })).toBe("Invalid blockIndex");
    expect(validateIngestBody({ ...validBody, blockIndex: 1.5 })).toBe("Invalid blockIndex");
    expect(validateIngestBody({ ...validBody, blockIndex: 100_001 })).toBe("Invalid blockIndex");
  });

  it("rejects negative startMs and endMs < startMs", () => {
    expect(validateIngestBody({ ...validBody, startMs: -1 })).toBe("Invalid startMs");
    expect(validateIngestBody({ ...validBody, startMs: 100, endMs: 50 })).toBe("Invalid endMs");
  });

  it("rejects non-array or empty events", () => {
    expect(validateIngestBody({ ...validBody, events: "not-array" })).toBe("events must be an array");
    expect(validateIngestBody({ ...validBody, events: [] })).toBe("events cannot be empty");
  });

  it("rejects too many events", () => {
    const events = Array.from({ length: 10_001 }, () => ({ type: 1 }));
    expect(validateIngestBody({ ...validBody, events })).toMatch(/exceeds max/);
  });
});

describe("extractClickSelectors", () => {
  it("extracts click selectors from rrweb MouseInteraction events", () => {
    const events = [
      { type: 3, data: { source: 2, type: 2, selector: "button.submit" } }, // click
      { type: 3, data: { source: 2, type: 1, selector: "button.hover" } },  // mouseup, not click
      { type: 3, data: { source: 5, selector: "input.email" } },             // input, not mouse
      { type: 4, data: { href: "https://example.com" } },                    // meta event
    ];
    expect(extractClickSelectors(events)).toEqual(["button.submit"]);
  });

  it("dedupes selectors", () => {
    const events = [
      { type: 3, data: { source: 2, type: 2, selector: "a.link" } },
      { type: 3, data: { source: 2, type: 2, selector: "a.link" } },
      { type: 3, data: { source: 2, type: 2, selector: "a.link" } },
    ];
    expect(extractClickSelectors(events)).toEqual(["a.link"]);
  });

  it("truncates selectors to 200 chars", () => {
    const long = "a".repeat(300);
    const events = [{ type: 3, data: { source: 2, type: 2, selector: long } }];
    const result = extractClickSelectors(events);
    expect(result[0]).toHaveLength(200);
  });

  it("handles malformed events gracefully", () => {
    expect(extractClickSelectors([null, undefined, 42, "string", {}])).toEqual([]);
  });
});

describe("extractUrls", () => {
  it("extracts hrefs from rrweb meta events (type 4)", () => {
    const events = [
      { type: 4, data: { href: "https://app.example.com/page1" } },
      { type: 4, data: { href: "https://app.example.com/page2" } },
      { type: 3, data: { source: 2 } }, // not a meta event
    ];
    expect(extractUrls(events)).toEqual([
      "https://app.example.com/page1",
      "https://app.example.com/page2",
    ]);
  });

  it("dedupes URLs", () => {
    const events = [
      { type: 4, data: { href: "https://example.com/" } },
      { type: 4, data: { href: "https://example.com/" } },
    ];
    expect(extractUrls(events)).toEqual(["https://example.com/"]);
  });

  it("truncates long URLs to 500 chars", () => {
    const long = "https://example.com/" + "a".repeat(600);
    const events = [{ type: 4, data: { href: long } }];
    expect(extractUrls(events)[0]).toHaveLength(500);
  });
});

describe("extractErrorFingerprints", () => {
  it("extracts fingerprints from events tagged with _kind=error", () => {
    const events = [
      { _kind: "error", fingerprint: "abc123" },
      { _kind: "error", fingerprint: "def456" },
      { _kind: "network", fingerprint: "should-ignore" }, // wrong kind
      { type: 3, data: {} }, // rrweb, not error
    ];
    expect(extractErrorFingerprints(events)).toEqual(["abc123", "def456"]);
  });

  it("dedupes fingerprints", () => {
    const events = [
      { _kind: "error", fingerprint: "same" },
      { _kind: "error", fingerprint: "same" },
    ];
    expect(extractErrorFingerprints(events)).toEqual(["same"]);
  });
});
