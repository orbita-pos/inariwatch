import { describe, it, expect } from "vitest";
import { deriveDetailedEvents, findActiveIndex, type DetailedEvent } from "./derive-detailed-events";

const BASE = 1_700_000_000_000;

describe("deriveDetailedEvents", () => {
  it("returns [] for empty input", () => {
    expect(deriveDetailedEvents([], BASE)).toEqual([]);
  });

  it("extracts console events with all 4 levels", () => {
    const events = [
      { _kind: "console", timestamp: BASE + 100, level: "error", message: "boom" },
      { _kind: "console", timestamp: BASE + 200, level: "warn", message: "slow" },
      { _kind: "console", timestamp: BASE + 300, level: "info", message: "hi" },
      { _kind: "console", timestamp: BASE + 400, level: "log", message: "x" },
    ];
    const out = deriveDetailedEvents(events, BASE);
    expect(out).toHaveLength(4);
    expect(out.map((e) => e.kind)).toEqual(["console", "console", "console", "console"]);
    expect((out[0] as { level: string }).level).toBe("error");
    expect((out[3] as { level: string }).level).toBe("log");
  });

  it("normalizes unknown console level to 'log'", () => {
    const events = [
      { _kind: "console", timestamp: BASE, level: "debug", message: "x" },
      { _kind: "console", timestamp: BASE, level: undefined, message: "y" },
    ];
    const out = deriveDetailedEvents(events, BASE);
    expect(out.every((e) => e.kind === "console" && e.level === "log")).toBe(true);
  });

  it("extracts network events with method / url / status / duration", () => {
    const events = [
      {
        _kind: "network",
        timestamp: BASE + 500,
        method: "POST",
        url: "https://api.example.com/users",
        status: 201,
        durationMs: 150,
      },
    ];
    const out = deriveDetailedEvents(events, BASE);
    expect(out[0]).toEqual({
      kind: "network",
      timestamp: 500,
      method: "POST",
      url: "https://api.example.com/users",
      status: 201,
      durationMs: 150,
      errorMessage: undefined,
    });
  });

  it("preserves network errorMessage when status is missing", () => {
    const events = [
      {
        _kind: "network",
        timestamp: BASE,
        method: "GET",
        url: "https://down.io",
        errorMessage: "ECONNREFUSED",
      },
    ];
    const out = deriveDetailedEvents(events, BASE) as Extract<DetailedEvent, { kind: "network" }>[];
    expect(out[0].errorMessage).toBe("ECONNREFUSED");
    expect(out[0].status).toBeUndefined();
  });

  it("defaults network method to GET when missing", () => {
    const events = [{ _kind: "network", timestamp: BASE, url: "/x" }];
    const out = deriveDetailedEvents(events, BASE) as Extract<DetailedEvent, { kind: "network" }>[];
    expect(out[0].method).toBe("GET");
  });

  it("extracts error events with fingerprint + message", () => {
    const events = [
      { _kind: "error", timestamp: BASE + 900, fingerprint: "abc123", message: "TypeError: bad" },
    ];
    const out = deriveDetailedEvents(events, BASE);
    expect(out[0]).toEqual({
      kind: "error",
      timestamp: 900,
      fingerprint: "abc123",
      message: "TypeError: bad",
    });
  });

  it("extracts nav events from rrweb meta (type 4) with href", () => {
    const events = [
      { type: 4, timestamp: BASE + 50, data: { href: "https://app.com/", width: 1440, height: 900 } },
      { type: 4, timestamp: BASE + 10_000, data: { href: "https://app.com/settings", width: 1440, height: 900 } },
    ];
    const out = deriveDetailedEvents(events, BASE);
    expect(out).toHaveLength(2);
    expect(out[0].kind).toBe("nav");
    expect((out[0] as { href: string }).href).toBe("https://app.com/");
    expect((out[1] as { href: string }).href).toBe("https://app.com/settings");
  });

  it("extracts SPA nav events from capture SDK (_kind: 'nav')", () => {
    const events = [
      { _kind: "nav", timestamp: BASE + 100, href: "https://app.com/cart" },
      { _kind: "nav", timestamp: BASE + 5000, href: "https://app.com/checkout" },
    ];
    const out = deriveDetailedEvents(events, BASE);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ kind: "nav", timestamp: 100, href: "https://app.com/cart" });
    expect(out[1]).toEqual({ kind: "nav", timestamp: 5000, href: "https://app.com/checkout" });
  });

  it("ignores _kind:nav events without href", () => {
    const events = [{ _kind: "nav", timestamp: BASE }];
    expect(deriveDetailedEvents(events, BASE)).toEqual([]);
  });

  it("ignores type=4 events without href", () => {
    const events = [{ type: 4, timestamp: BASE, data: { width: 100, height: 100 } }];
    expect(deriveDetailedEvents(events, BASE)).toEqual([]);
  });

  it("ignores rrweb incremental (type 3) mutations — panels don't show them", () => {
    const events = [
      { type: 3, timestamp: BASE, data: { source: 0, texts: [], attributes: [], removes: [], adds: [] } },
      { type: 3, timestamp: BASE, data: { source: 2, type: 2, selector: "button.x" } },
    ];
    expect(deriveDetailedEvents(events, BASE)).toEqual([]);
  });

  it("computes timestamps relative to sessionStartMs", () => {
    const events = [
      { _kind: "console", timestamp: BASE + 5000, level: "error", message: "a" },
      { _kind: "console", timestamp: BASE + 10_000, level: "error", message: "b" },
    ];
    const out = deriveDetailedEvents(events, BASE);
    expect(out.map((e) => e.timestamp)).toEqual([5000, 10_000]);
  });

  it("clamps negative relative timestamps to 0 (events before sessionStartMs)", () => {
    const events = [{ _kind: "console", timestamp: BASE - 1000, level: "error", message: "early" }];
    const out = deriveDetailedEvents(events, BASE);
    expect(out[0].timestamp).toBe(0);
  });

  it("sorts output chronologically even if input is shuffled", () => {
    const events = [
      { _kind: "console", timestamp: BASE + 500, level: "error", message: "late" },
      { _kind: "console", timestamp: BASE + 100, level: "error", message: "early" },
      { _kind: "error", timestamp: BASE + 300, fingerprint: "fp", message: "mid" },
    ];
    const out = deriveDetailedEvents(events, BASE);
    expect(out.map((e) => e.timestamp)).toEqual([100, 300, 500]);
  });

  it("skips non-object / malformed events gracefully", () => {
    const events = [null, undefined, 42, "string", {}, { _kind: "unknown" }];
    expect(deriveDetailedEvents(events, BASE)).toEqual([]);
  });

  it("mixes all four kinds in one pass", () => {
    const events = [
      { _kind: "console", timestamp: BASE + 100, level: "error", message: "c" },
      { _kind: "network", timestamp: BASE + 200, method: "GET", url: "/a" },
      { _kind: "error", timestamp: BASE + 300, fingerprint: "x", message: "e" },
      { type: 4, timestamp: BASE + 400, data: { href: "/n" } },
    ];
    const out = deriveDetailedEvents(events, BASE);
    expect(out.map((e) => e.kind)).toEqual(["console", "network", "error", "nav"]);
  });
});

describe("findActiveIndex", () => {
  const events: DetailedEvent[] = [
    { kind: "console", timestamp: 100, level: "error", message: "a" },
    { kind: "console", timestamp: 500, level: "error", message: "b" },
    { kind: "console", timestamp: 1000, level: "error", message: "c" },
  ];

  it("returns -1 for empty array", () => {
    expect(findActiveIndex([], 500)).toBe(-1);
  });

  it("returns -1 when currentMs precedes all events", () => {
    expect(findActiveIndex(events, 50)).toBe(-1);
  });

  it("returns 0 at first event timestamp", () => {
    expect(findActiveIndex(events, 100)).toBe(0);
  });

  it("returns last event before currentMs", () => {
    expect(findActiveIndex(events, 700)).toBe(1);
  });

  it("returns final index when currentMs exceeds all events", () => {
    expect(findActiveIndex(events, 99_999)).toBe(events.length - 1);
  });

  it("matches exact boundary — returns the event at that ts", () => {
    expect(findActiveIndex(events, 500)).toBe(1);
  });
});
