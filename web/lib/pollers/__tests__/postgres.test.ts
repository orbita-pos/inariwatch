import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock pg ──────────────────────────────────────────────────────────────────

// These hold per-test overrides so we can inject different behavior
let mockConnect: ReturnType<typeof vi.fn>;
let mockQuery: ReturnType<typeof vi.fn>;
let mockEnd: ReturnType<typeof vi.fn>;

vi.mock("pg", () => {
  const Client = vi.fn().mockImplementation(() => ({
    connect: (...args: unknown[]) => mockConnect(...args),
    query: (...args: unknown[]) => mockQuery(...args),
    end: (...args: unknown[]) => mockEnd(...args),
  }));
  return { Client };
});

// Import AFTER mock is set up
const { pollPostgres } = await import("../postgres");

// ── Helpers ──────────────────────────────────────────────────────────────────

const BASE_CONFIG = { connectionString: "postgres://localhost/mydb", name: "MyDB" };

function makeConnResult(active: number, max: number) {
  return { rows: [{ active, max }] };
}

function makeLongQueryResult(count: number) {
  return {
    rows: Array.from({ length: count }, (_, i) => ({
      pid: 1000 + i,
      duration_sec: 60 + i,
      query: `SELECT * FROM table_${i}`,
    })),
  };
}

function emptyResult() {
  return { rows: [] };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("pollPostgres", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockConnect = vi.fn().mockResolvedValue(undefined);
    mockEnd = vi.fn().mockResolvedValue(undefined);
    // Default: no high connections, no long queries, no db size error
    mockQuery = vi.fn()
      .mockResolvedValueOnce(makeConnResult(10, 100))   // connection count query
      .mockResolvedValueOnce(emptyResult())              // long queries
      .mockResolvedValueOnce({ rows: [{ size_bytes: 1024 }] }); // db size
  });

  it("creates a critical alert when connection fails", async () => {
    mockConnect = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const alerts = await pollPostgres(BASE_CONFIG);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("critical");
    expect(alerts[0].title).toBe("[Postgres] Connection failed — MyDB");
    expect(alerts[0].body).toContain("ECONNREFUSED");
  });

  it("skips connection failure alert when connection_failed.enabled is false", async () => {
    mockConnect = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const alerts = await pollPostgres(BASE_CONFIG, { connection_failed: { enabled: false } });
    expect(alerts).toEqual([]);
  });

  it("returns [] when all metrics are healthy", async () => {
    const alerts = await pollPostgres(BASE_CONFIG);
    expect(alerts).toEqual([]);
  });

  it("creates a warning alert when connections exceed the threshold but are below 95%", async () => {
    mockQuery = vi.fn()
      .mockResolvedValueOnce(makeConnResult(85, 100))  // 85% — above default 80% threshold, below 95%
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce({ rows: [{ size_bytes: 1024 }] });

    const alerts = await pollPostgres(BASE_CONFIG, { high_connections: { enabled: true, thresholdPercent: 80 } });

    const connAlert = alerts.find((a) => a.title.includes("High connections"));
    expect(connAlert).toBeDefined();
    expect(connAlert!.severity).toBe("warning");
    expect(connAlert!.title).toContain("85%");
  });

  it("creates a critical alert when connections are at or above 95%", async () => {
    mockQuery = vi.fn()
      .mockResolvedValueOnce(makeConnResult(96, 100))  // 96%
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce({ rows: [{ size_bytes: 1024 }] });

    const alerts = await pollPostgres(BASE_CONFIG, { high_connections: { enabled: true, thresholdPercent: 80 } });

    const connAlert = alerts.find((a) => a.title.includes("High connections"));
    expect(connAlert).toBeDefined();
    expect(connAlert!.severity).toBe("critical");
  });

  it("creates a warning alert when long-running queries are detected", async () => {
    mockQuery = vi.fn()
      .mockResolvedValueOnce(makeConnResult(10, 100))
      .mockResolvedValueOnce(makeLongQueryResult(2))
      .mockResolvedValueOnce({ rows: [{ size_bytes: 1024 }] });

    const alerts = await pollPostgres(BASE_CONFIG);

    const lqAlert = alerts.find((a) => a.title.includes("long-running"));
    expect(lqAlert).toBeDefined();
    expect(lqAlert!.severity).toBe("warning");
    expect(lqAlert!.body).toContain("PID");
  });

  it("returns no long-query alert when there are no long-running queries", async () => {
    // mockQuery is already set to return emptyResult for long queries in beforeEach
    const alerts = await pollPostgres(BASE_CONFIG);

    expect(alerts.some((a) => a.title.includes("long-running"))).toBe(false);
  });

  it("always calls client.end() even when queries succeed", async () => {
    await pollPostgres(BASE_CONFIG);
    expect(mockEnd).toHaveBeenCalled();
  });
});
