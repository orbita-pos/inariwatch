/**
 * Tests for FullTrace session id extraction (server side).
 *
 * The extractor is the only thing standing between an attacker-controlled
 * header and our database — the validation regex MUST stay loose enough for
 * legit alt-id schemes (ULID, NanoID) but tight enough to reject SQL/XSS
 * payloads. Most tests here exist to lock down that boundary.
 */

import { describe, it, expect } from "vitest";
import {
  readSessionHeader,
  readSessionMetadata,
  extractSessionId,
} from "@/lib/fulltrace/session-header";

function headersWith(name: string, value: string): Headers {
  const h = new Headers();
  h.set(name, value);
  return h;
}

describe("readSessionHeader", () => {
  it("returns null when X-IW-Session-Id header is absent", () => {
    expect(readSessionHeader(new Headers())).toBeNull();
  });

  it("reads the header from a Headers object", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    expect(readSessionHeader(headersWith("X-IW-Session-Id", id))).toBe(id);
  });

  it("reads the header from a Request object", () => {
    const id = "abc12345";
    const req = new Request("https://example.com/api", { headers: { "X-IW-Session-Id": id } });
    expect(readSessionHeader(req)).toBe(id);
  });

  it("is case-insensitive on the header name (matches Headers.get behavior)", () => {
    const id = "abc12345";
    expect(readSessionHeader(headersWith("x-iw-session-id", id))).toBe(id);
    expect(readSessionHeader(headersWith("X-IW-SESSION-ID", id))).toBe(id);
  });

  it("trims whitespace before validation", () => {
    expect(readSessionHeader(headersWith("X-IW-Session-Id", "  abc12345  "))).toBe("abc12345");
  });

  it("accepts UUIDs (canonical browser-generated format)", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    expect(readSessionHeader(headersWith("X-IW-Session-Id", id))).toBe(id);
  });

  it("accepts ULIDs (alt scheme some hosts use)", () => {
    expect(readSessionHeader(headersWith("X-IW-Session-Id", "01HK6V0G4JBEX5N3PFKM4ZQT8R"))).toBe(
      "01HK6V0G4JBEX5N3PFKM4ZQT8R",
    );
  });

  it("accepts NanoID-style ids", () => {
    expect(readSessionHeader(headersWith("X-IW-Session-Id", "V1StGXR8_Z5jdHi6B-myT"))).toBe(
      "V1StGXR8_Z5jdHi6B-myT",
    );
  });

  it("rejects ids shorter than 8 chars (too easy to collide)", () => {
    expect(readSessionHeader(headersWith("X-IW-Session-Id", "abc"))).toBeNull();
    expect(readSessionHeader(headersWith("X-IW-Session-Id", "1234567"))).toBeNull();
  });

  it("rejects ids longer than 64 chars (anti-bloat)", () => {
    const tooLong = "a".repeat(65);
    expect(readSessionHeader(headersWith("X-IW-Session-Id", tooLong))).toBeNull();
  });

  it("rejects ids with characters outside [A-Za-z0-9_-]", () => {
    expect(readSessionHeader(headersWith("X-IW-Session-Id", "abc def 12"))).toBeNull();
    expect(readSessionHeader(headersWith("X-IW-Session-Id", "abc;DROP TABLE users"))).toBeNull();
    expect(readSessionHeader(headersWith("X-IW-Session-Id", "<script>alert(1)</script>"))).toBeNull();
    expect(readSessionHeader(headersWith("X-IW-Session-Id", "abc/../../etc"))).toBeNull();
  });

  it("rejects empty string", () => {
    expect(readSessionHeader(headersWith("X-IW-Session-Id", ""))).toBeNull();
  });
});

describe("readSessionMetadata", () => {
  it("returns null for undefined event", () => {
    expect(readSessionMetadata(undefined)).toBeNull();
  });

  it("returns null when metadata is missing", () => {
    expect(readSessionMetadata({})).toBeNull();
  });

  it("returns null when sessionId is missing from metadata", () => {
    expect(readSessionMetadata({ metadata: { foo: "bar" } })).toBeNull();
  });

  it("reads metadata.sessionId when present", () => {
    expect(readSessionMetadata({ metadata: { sessionId: "abcdef12" } })).toBe("abcdef12");
  });

  it("falls back to metadata.replaySessionId for legacy SDK payloads", () => {
    expect(readSessionMetadata({ metadata: { replaySessionId: "abcdef12" } })).toBe("abcdef12");
  });

  it("prefers sessionId over replaySessionId when both present", () => {
    expect(
      readSessionMetadata({ metadata: { sessionId: "newid123", replaySessionId: "oldid456" } }),
    ).toBe("newid123");
  });

  it("returns null when sessionId is not a string (defensive)", () => {
    expect(readSessionMetadata({ metadata: { sessionId: 12345 } })).toBeNull();
    expect(readSessionMetadata({ metadata: { sessionId: null } })).toBeNull();
    expect(readSessionMetadata({ metadata: { sessionId: { id: "abc" } } })).toBeNull();
  });

  it("applies the same validation regex as the header path", () => {
    expect(readSessionMetadata({ metadata: { sessionId: "abc" } })).toBeNull(); // too short
    expect(readSessionMetadata({ metadata: { sessionId: "abc;DROP" } })).toBeNull(); // bad chars
  });
});

describe("extractSessionId", () => {
  it("returns null when neither header nor metadata is present", () => {
    expect(extractSessionId(new Headers())).toBeNull();
  });

  it("prefers the header over metadata when both exist", () => {
    const h = headersWith("X-IW-Session-Id", "fromheader1");
    const evt = { metadata: { sessionId: "frommetadata" } };
    expect(extractSessionId(h, evt)).toBe("fromheader1");
  });

  it("falls back to metadata when header is absent", () => {
    expect(extractSessionId(new Headers(), { metadata: { sessionId: "frommetadata" } })).toBe(
      "frommetadata",
    );
  });

  it("falls back to metadata when header is invalid (defensive — never trust attacker input)", () => {
    const h = headersWith("X-IW-Session-Id", "ab"); // too short, invalid
    expect(extractSessionId(h, { metadata: { sessionId: "validmeta" } })).toBe("validmeta");
  });
});
