/**
 * Tests for GET /api/cron/eap-verify-sweep — hourly local-verify backfill.
 *
 * Covers: auth, happy path with stats surfaced, flag-off no-op,
 * exception propagation as 500.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.spyOn(console, "log").mockImplementation(() => undefined);
vi.spyOn(console, "error").mockImplementation(() => undefined);

const sweepMock = vi.fn();
const flagMock = vi.fn();

vi.mock("@/lib/services/eap-verify-local", () => ({
  sweepUnverifiedReceipts: () => sweepMock(),
  isLocalVerifyEnabled: () => flagMock(),
}));

const pingHealthSpy = vi.fn(async (_route: string, _ok: boolean) => undefined);
vi.mock("@/lib/cron-utils", async () => {
  const actual = await vi.importActual<typeof import("@/lib/cron-utils")>(
    "@/lib/cron-utils",
  );
  return {
    ...actual,
    pingCronHealth: (...args: unknown[]) => pingHealthSpy(...args as [string, boolean]),
  };
});

function mkReq(token?: string): Request {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request("https://app.inariwatch.com/api/cron/eap-verify-sweep", {
    headers,
  });
}

async function loadRoute() {
  return (await import("../route")) as typeof import("../route");
}

beforeEach(() => {
  vi.unstubAllEnvs();
  sweepMock.mockReset();
  flagMock.mockReset();
  pingHealthSpy.mockReset();
});

describe("GET /api/cron/eap-verify-sweep", () => {
  it("rejects requests without the correct Bearer token", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const { GET } = await loadRoute();
    const res = await GET(mkReq("wrong"));
    expect(res.status).toBe(401);
  });

  it("rejects requests when CRON_SECRET is unset", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const { GET } = await loadRoute();
    const res = await GET(mkReq("anything"));
    expect(res.status).toBe(401);
  });

  it("returns 200 with stats when sweep succeeds", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    flagMock.mockReturnValue(true);
    sweepMock.mockResolvedValue({
      scanned: 42,
      verified: 41,
      failed: 1,
      skipped: 0,
      durationMs: 73,
    });

    const { GET } = await loadRoute();
    const res = await GET(mkReq("s3cret"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.stats).toEqual({
      scanned: 42,
      verified: 41,
      failed: 1,
      skipped: 0,
      durationMs: 73,
    });
    expect(sweepMock).toHaveBeenCalledTimes(1);
  });

  it("still returns 200 when feature flag is off (no-op sweep)", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    flagMock.mockReturnValue(false);
    sweepMock.mockResolvedValue({
      scanned: 0,
      verified: 0,
      failed: 0,
      skipped: 0,
      durationMs: 0,
    });
    const { GET } = await loadRoute();
    const res = await GET(mkReq("s3cret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.stats.scanned).toBe(0);
  });

  it("returns 500 when sweep throws", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    flagMock.mockReturnValue(true);
    sweepMock.mockRejectedValue(new Error("db down"));
    const { GET } = await loadRoute();
    const res = await GET(mkReq("s3cret"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/db down/);
  });

  it("pings cron health with ok=true on success", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    flagMock.mockReturnValue(true);
    sweepMock.mockResolvedValue({
      scanned: 1,
      verified: 1,
      failed: 0,
      skipped: 0,
      durationMs: 1,
    });
    const { GET } = await loadRoute();
    await GET(mkReq("s3cret"));
    expect(pingHealthSpy).toHaveBeenCalledWith("eap-verify-sweep", true);
  });

  it("pings cron health with ok=false on failure", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    flagMock.mockReturnValue(true);
    sweepMock.mockRejectedValue(new Error("boom"));
    const { GET } = await loadRoute();
    await GET(mkReq("s3cret"));
    expect(pingHealthSpy).toHaveBeenCalledWith("eap-verify-sweep", false);
  });
});
