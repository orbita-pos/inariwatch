import { describe, it, expect, vi, beforeEach } from "vitest";
import { pollVercel } from "../vercel-api";

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockResponse(body: unknown, ok = true) {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function makeDeployment(overrides: Partial<{
  uid: string;
  name: string;
  state: string;
  target: string | null;
  url: string;
  errorMessage: string;
}> = {}) {
  return {
    uid: "dpl-1",
    name: "my-app",
    state: "ERROR",
    target: "production",
    url: "my-app-abc.vercel.app",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("pollVercel", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns [] when API responds with non-OK", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(mockResponse(null, false));

    const alerts = await pollVercel("tok", "team-1");
    expect(alerts).toEqual([]);
  });

  it("creates a critical alert for a production deploy with state ERROR", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      mockResponse({ deployments: [makeDeployment({ state: "ERROR", target: "production" })] })
    );

    const alerts = await pollVercel("tok", "team-1");

    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("critical");
    expect(alerts[0].title).toBe("Production deploy failed — my-app");
  });

  it("creates a critical alert for a production deploy with state CANCELED", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      mockResponse({ deployments: [makeDeployment({ state: "CANCELED", target: "production" })] })
    );

    const alerts = await pollVercel("tok", "team-1");

    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("critical");
  });

  it("creates a warning alert for a failed preview deploy when failed_preview.enabled is true", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      mockResponse({ deployments: [makeDeployment({ state: "ERROR", target: null })] })
    );

    const alerts = await pollVercel("tok", "team-1", { failed_preview: { enabled: true } });

    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("warning");
    expect(alerts[0].title).toBe("Preview deploy failed — my-app");
  });

  it("skips preview deploys when failed_preview.enabled is false (default)", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      mockResponse({ deployments: [makeDeployment({ state: "ERROR", target: null })] })
    );

    const alerts = await pollVercel("tok", "team-1");
    expect(alerts).toEqual([]);
  });

  it("skips production deploys when failed_production.enabled is false", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      mockResponse({ deployments: [makeDeployment({ state: "ERROR", target: "production" })] })
    );

    const alerts = await pollVercel("tok", "team-1", { failed_production: { enabled: false } });
    expect(alerts).toEqual([]);
  });

  it("respects projectFilter and skips non-matching deployments", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      mockResponse({
        deployments: [
          makeDeployment({ name: "my-app", state: "ERROR", target: "production" }),
          makeDeployment({ uid: "dpl-2", name: "other-app", state: "ERROR", target: "production" }),
        ],
      })
    );

    const alerts = await pollVercel("tok", "team-1", { projectFilter: ["my-app"] });

    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toContain("my-app");
  });

  it("returns no alert for a READY deploy", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      mockResponse({ deployments: [makeDeployment({ state: "READY", target: "production" })] })
    );

    const alerts = await pollVercel("tok", "team-1");
    expect(alerts).toEqual([]);
  });

  it("includes the errorMessage in the alert body when present", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      mockResponse({
        deployments: [
          makeDeployment({ state: "ERROR", target: "production", errorMessage: "Out of memory" }),
        ],
      })
    );

    const alerts = await pollVercel("tok", "team-1");

    expect(alerts[0].body).toContain("Out of memory");
  });
});
