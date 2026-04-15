import { describe, it, expect } from "vitest";
import { detectCausalChains, detectFirstCausalChain } from "../replay-causal-chain";

// ── Event factories ────────────────────────────────────────────────────────

const click = (timestamp: number, selector: string) => ({
  type: 3, timestamp, data: { source: 2, type: 2, selector },
});

const networkEvent = (timestamp: number, method: string, url: string, status?: number, traceId?: string) => ({
  _kind: "network" as const, timestamp, method, url, status, traceId,
});

const substrateEvent = (timestamp: number, type: string, detail: Record<string, unknown> = {}) => ({
  _kind: "substrate" as const, timestamp, kind: { type, ...detail },
});

const errorEvent = (timestamp: number, fingerprint: string, message: string) => ({
  _kind: "error" as const, timestamp, fingerprint, message,
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("detectCausalChains", () => {
  it("returns empty when there are no errors", () => {
    const events = [
      click(100, "button.a"),
      networkEvent(200, "GET", "/foo"),
    ];
    expect(detectCausalChains(events)).toEqual([]);
  });

  it("builds a full chain: click → http → db → error", () => {
    const events = [
      click(1_000, "button.submit"),
      networkEvent(1_100, "POST", "/api/users", 500, "trace-1"),
      substrateEvent(1_200, "HttpRequest", { url: "/api/users", trace_id: "trace-1" }),
      substrateEvent(1_250, "DbQuery", { query: "INSERT INTO users", trace_id: "trace-1" }),
      errorEvent(1_300, "fp-1", "DB timeout"),
    ];

    const chains = detectCausalChains(events);
    expect(chains).toHaveLength(1);

    const chain = chains[0];
    expect(chain.errorFingerprint).toBe("fp-1");
    // Forward order: user_action, http_cause, db_cause, error
    const roles = chain.links.map((l) => l.role);
    expect(roles).toEqual(["user_action", "http_cause", "db_cause", "error"]);
    expect(chain.links[0].summary).toContain("button.submit");
    expect(chain.links[3].summary).toBe("DB timeout");
  });

  it("works with just a click + error (no network/db)", () => {
    const events = [
      click(500, "a.link"),
      errorEvent(600, "fp-2", "Null reference"),
    ];
    const chain = detectFirstCausalChain(events);
    expect(chain).not.toBeNull();
    expect(chain!.links.map((l) => l.role)).toEqual(["user_action", "error"]);
  });

  it("dedupes chains by fingerprint — only first error of each fp gets a chain", () => {
    const events = [
      click(100, "button"),
      errorEvent(200, "same-fp", "Repeated error"),
      errorEvent(500, "same-fp", "Repeated error"),
      errorEvent(800, "other-fp", "Different error"),
    ];
    const chains = detectCausalChains(events);
    expect(chains).toHaveLength(2);
    expect(chains[0].errorFingerprint).toBe("same-fp");
    expect(chains[1].errorFingerprint).toBe("other-fp");
  });

  it("picks the last DB query before the error, not one from later", () => {
    const events = [
      substrateEvent(100, "DbQuery", { query: "SELECT 1" }),
      substrateEvent(500, "DbQuery", { query: "SELECT target" }),
      errorEvent(600, "fp", "fail"),
      substrateEvent(700, "DbQuery", { query: "SELECT later" }),
    ];
    const chain = detectFirstCausalChain(events);
    expect(chain).not.toBeNull();
    const db = chain!.links.find((l) => l.role === "db_cause");
    expect(db?.summary).toContain("SELECT target");
  });

  it("prefers an HTTP request sharing trace id with the DB query", () => {
    const events = [
      networkEvent(100, "GET", "/other", 200, "trace-other"),
      networkEvent(200, "POST", "/target", 500, "trace-target"),
      networkEvent(300, "GET", "/later-same-trace", 200, "trace-target"), // before error, same trace
      substrateEvent(400, "DbQuery", { query: "INSERT target", trace_id: "trace-target" }),
      errorEvent(500, "fp", "boom"),
    ];
    const chain = detectFirstCausalChain(events);
    const http = chain!.links.find((l) => l.role === "http_cause");
    // Should pick the most recent matching-trace request before the error
    expect(http?.summary).toContain("/later-same-trace");
  });

  it("falls back to last 4xx/5xx network if no matching trace id", () => {
    const events = [
      networkEvent(100, "GET", "/200ok", 200),
      networkEvent(200, "POST", "/500boom", 500),
      errorEvent(300, "fp", "boom"),
    ];
    const chain = detectFirstCausalChain(events);
    const http = chain!.links.find((l) => l.role === "http_cause");
    expect(http?.summary).toContain("/500boom");
  });

  it("handles malformed events gracefully", () => {
    const events = [null, undefined, 42, "string", {}, errorEvent(100, "fp", "ok")];
    const chains = detectCausalChains(events);
    expect(chains).toHaveLength(1);
    expect(chains[0].links.map((l) => l.role)).toEqual(["error"]);
  });

  it("does not pick clicks that happen after the HTTP request", () => {
    const events = [
      click(100, "button.first"),
      networkEvent(200, "POST", "/api", 500),
      click(300, "button.afterwards"), // after the HTTP — shouldn't be picked
      errorEvent(400, "fp", "oops"),
    ];
    const chain = detectFirstCausalChain(events);
    const user = chain!.links.find((l) => l.role === "user_action");
    expect(user?.summary).toContain("button.first");
  });

  it("returns empty array on non-array input", () => {
    // @ts-expect-error intentional bad input
    expect(detectCausalChains(null)).toEqual([]);
    // @ts-expect-error intentional bad input
    expect(detectCausalChains("string")).toEqual([]);
  });
});
