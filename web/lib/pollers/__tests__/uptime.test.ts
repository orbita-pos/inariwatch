import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pollUptime, UptimeEndpoint } from "../uptime";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEndpoint(overrides: Partial<UptimeEndpoint> = {}): UptimeEndpoint {
  return {
    url: "https://example.com/health",
    name: "Example",
    expectedStatus: 200,
    timeoutMs: 5000,
    ...overrides,
  };
}

function mockOkResponse(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("pollUptime", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns [] when all endpoints are healthy and fast", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(mockOkResponse(200));

    const alerts = await pollUptime([makeEndpoint()]);
    expect(alerts).toEqual([]);
  });

  it("creates a critical alert when the response status code does not match expectedStatus", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(mockOkResponse(503));

    const alerts = await pollUptime([makeEndpoint({ expectedStatus: 200 })]);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("critical");
    expect(alerts[0].title).toContain("[Down]");
    expect(alerts[0].title).toContain("Example");
    expect(alerts[0].body).toContain("503");
  });

  it("creates a warning alert when response is slow and exceeds slowThreshold", async () => {
    vi.useFakeTimers();

    // Advance clock by 6000ms during the fetch so elapsed > default 5000ms threshold
    vi.spyOn(global, "fetch").mockImplementation(() => {
      vi.advanceTimersByTime(6000);
      return Promise.resolve(mockOkResponse(200));
    });

    const alerts = await pollUptime(
      [makeEndpoint({ timeoutMs: 30000 })],
      { slow_response: { enabled: true, thresholdMs: 5000 } }
    );

    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("warning");
    expect(alerts[0].title).toContain("[Slow]");
  });

  it("creates a critical alert when fetch throws a network error", async () => {
    vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const alerts = await pollUptime([makeEndpoint()]);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("critical");
    expect(alerts[0].title).toContain("[Down]");
    expect(alerts[0].body).toContain("ECONNREFUSED");
  });

  it("creates a critical alert with 'timed out' in the body on AbortError", async () => {
    vi.spyOn(global, "fetch").mockRejectedValueOnce(
      Object.assign(new DOMException("The operation was aborted.", "AbortError"))
    );

    const alerts = await pollUptime([makeEndpoint({ timeoutMs: 100 })]);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("critical");
    expect(alerts[0].body).toContain("timed out");
  });

  it("skips down alerts when downtime.enabled is false", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(mockOkResponse(503));

    const alerts = await pollUptime(
      [makeEndpoint()],
      { downtime: { enabled: false } }
    );

    expect(alerts).toEqual([]);
  });

  it("skips slow alerts when slow_response.enabled is false", async () => {
    vi.useFakeTimers();

    vi.spyOn(global, "fetch").mockImplementation(() => {
      vi.advanceTimersByTime(6000);
      return Promise.resolve(mockOkResponse(200));
    });

    const alerts = await pollUptime(
      [makeEndpoint({ timeoutMs: 30000 })],
      { slow_response: { enabled: false, thresholdMs: 5000 } }
    );

    expect(alerts).toEqual([]);
  });

  it("checks each endpoint independently — one down, one healthy", async () => {
    const fetchSpy = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(mockOkResponse(503))
      .mockResolvedValueOnce(mockOkResponse(200));

    const alerts = await pollUptime([
      makeEndpoint({ name: "API", url: "https://api.example.com" }),
      makeEndpoint({ name: "Web", url: "https://web.example.com" }),
    ]);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toContain("API");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
