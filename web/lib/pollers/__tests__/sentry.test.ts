import { describe, it, expect, vi, beforeEach } from "vitest";
import { pollSentry } from "../sentry";

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockResponse(body: unknown, ok = true) {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function makeIssue(overrides: Partial<{
  id: string;
  title: string;
  culprit: string;
  isNew: boolean;
  isRegression: boolean;
  count: string;
  userCount: number;
  project: { slug: string };
}> = {}) {
  return {
    id: "1",
    title: "TypeError: Cannot read property",
    culprit: "app/index.js",
    isNew: true,
    isRegression: false,
    count: "10",
    userCount: 3,
    project: { slug: "backend" },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("pollSentry", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns [] when org is an empty string", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");

    const alerts = await pollSentry("tok", "");
    expect(alerts).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns [] when API responds with non-OK", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(mockResponse(null, false));

    const alerts = await pollSentry("tok", "my-org");
    expect(alerts).toEqual([]);
  });

  it("creates a warning alert for a new issue (isNew: true)", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      mockResponse([makeIssue({ isNew: true, isRegression: false })])
    );

    const alerts = await pollSentry("tok", "my-org");

    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("warning");
    expect(alerts[0].title).toMatch(/^\[New Issue\]/);
  });

  it("creates a critical alert for a regression (isRegression: true)", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      mockResponse([makeIssue({ isNew: false, isRegression: true })])
    );

    const alerts = await pollSentry("tok", "my-org");

    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("critical");
    expect(alerts[0].title).toMatch(/^\[Regression\]/);
  });

  it("skips issues that are neither new nor a regression", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      mockResponse([makeIssue({ isNew: false, isRegression: false })])
    );

    const alerts = await pollSentry("tok", "my-org");
    expect(alerts).toEqual([]);
  });

  it("skips new issues when new_issues.enabled is false", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      mockResponse([makeIssue({ isNew: true, isRegression: false })])
    );

    const alerts = await pollSentry("tok", "my-org", { new_issues: { enabled: false } });
    expect(alerts).toEqual([]);
  });

  it("skips regressions when regressions.enabled is false", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      mockResponse([makeIssue({ isNew: false, isRegression: true })])
    );

    const alerts = await pollSentry("tok", "my-org", { regressions: { enabled: false } });
    expect(alerts).toEqual([]);
  });

  it("filters by sentryProjectFilter and skips non-matching projects", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      mockResponse([
        makeIssue({ id: "1", isNew: true, project: { slug: "backend" } }),
        makeIssue({ id: "2", isNew: true, project: { slug: "frontend" } }),
      ])
    );

    const alerts = await pollSentry("tok", "my-org", {
      sentryProjectFilter: ["backend"],
    });

    expect(alerts).toHaveLength(1);
    expect(alerts[0].body).toContain("app/index.js");
  });

  it("includes culprit, count and userCount in the alert body", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      mockResponse([makeIssue({ culprit: "worker.js", count: "42", userCount: 7, isNew: true })])
    );

    const alerts = await pollSentry("tok", "my-org");

    expect(alerts[0].body).toContain("worker.js");
    expect(alerts[0].body).toContain("42");
    expect(alerts[0].body).toContain("7");
  });
});
