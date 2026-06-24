import { describe, it, expect, vi, beforeEach } from "vitest";
import { pollGitHub } from "../github";

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const REPOS = [
  { full_name: "acme/api", name: "api", default_branch: "main" },
  { full_name: "acme/web", name: "web", default_branch: "main" },
];

function buildFetch({
  reposOk = true,
  checkRuns = [] as { name: string; conclusion: string | null }[],
  ciOk = true,
  prs = [] as object[],
  prsOk = true,
} = {}) {
  return vi.fn((url: string) => {
    const u = url as string;
    if (u.includes("/user/repos")) {
      return Promise.resolve(mockResponse(REPOS, reposOk));
    }
    if (u.includes("/check-runs")) {
      return Promise.resolve(mockResponse({ check_runs: checkRuns }, ciOk));
    }
    if (u.includes("/pulls")) {
      return Promise.resolve(mockResponse(prs, prsOk));
    }
    return Promise.resolve(mockResponse([], true));
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("pollGitHub", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns [] when the repos API responds with non-OK", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      mockResponse(null, false, 401)
    );

    const alerts = await pollGitHub("tok", "acme");
    expect(alerts).toEqual([]);
  });

  it("creates a critical alert when a check run has conclusion: failure", async () => {
    const fetch = buildFetch({
      checkRuns: [{ name: "build", conclusion: "failure" }],
    });
    vi.spyOn(global, "fetch").mockImplementation(fetch);

    const alerts = await pollGitHub("tok", "acme", { stale_pr: { enabled: false, days: 3 }, unreviewed_pr: { enabled: false, hours: 24 } });

    const ciAlert = alerts.find((a) => a.severity === "critical");
    expect(ciAlert).toBeDefined();
    expect(ciAlert!.title).toBe("CI failing on api/main");
    expect(ciAlert!.body).toContain("build");
  });

  it("treats timed_out check runs as failures", async () => {
    const fetch = buildFetch({
      checkRuns: [{ name: "test", conclusion: "timed_out" }],
    });
    vi.spyOn(global, "fetch").mockImplementation(fetch);

    const alerts = await pollGitHub("tok", "acme", { stale_pr: { enabled: false, days: 3 }, unreviewed_pr: { enabled: false, hours: 24 } });

    expect(alerts.some((a) => a.severity === "critical")).toBe(true);
  });

  it("returns [] when all check runs pass", async () => {
    const fetch = buildFetch({
      checkRuns: [{ name: "build", conclusion: "success" }],
    });
    vi.spyOn(global, "fetch").mockImplementation(fetch);

    const alerts = await pollGitHub("tok", "acme", { stale_pr: { enabled: false, days: 3 }, unreviewed_pr: { enabled: false, hours: 24 } });

    expect(alerts).toEqual([]);
  });

  it("detects stale PRs older than staleDays", async () => {
    const oldDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const fetch = buildFetch({
      checkRuns: [],
      prs: [
        { number: 1, title: "Old fix", draft: false, updated_at: oldDate, created_at: oldDate, requested_reviewers: [] },
      ],
    });
    vi.spyOn(global, "fetch").mockImplementation(fetch);

    const alerts = await pollGitHub("tok", "acme", { stale_pr: { enabled: true, days: 3 }, failed_ci: { enabled: false }, unreviewed_pr: { enabled: false, hours: 24 } });

    const staleAlert = alerts.find((a) => a.title.includes("stale"));
    expect(staleAlert).toBeDefined();
    expect(staleAlert!.severity).toBe("warning");
    expect(staleAlert!.title).toMatch(/1 stale PR\(s\) in api/);
  });

  it("skips draft PRs for stale detection", async () => {
    const oldDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const fetch = buildFetch({
      checkRuns: [],
      prs: [
        { number: 2, title: "Draft WIP", draft: true, updated_at: oldDate, created_at: oldDate, requested_reviewers: [] },
      ],
    });
    vi.spyOn(global, "fetch").mockImplementation(fetch);

    const alerts = await pollGitHub("tok", "acme", { stale_pr: { enabled: true, days: 3 }, failed_ci: { enabled: false }, unreviewed_pr: { enabled: false, hours: 24 } });

    expect(alerts.filter((a) => a.title.includes("stale"))).toHaveLength(0);
  });

  it("detects unreviewed PRs older than reviewHours", async () => {
    const oldDate = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    const fetch = buildFetch({
      checkRuns: [],
      prs: [
        { number: 3, title: "Needs review", draft: false, updated_at: oldDate, created_at: oldDate, requested_reviewers: [{ login: "reviewer" }] },
      ],
    });
    vi.spyOn(global, "fetch").mockImplementation(fetch);

    const alerts = await pollGitHub("tok", "acme", { stale_pr: { enabled: false, days: 3 }, failed_ci: { enabled: false }, unreviewed_pr: { enabled: true, hours: 24 } });

    const reviewAlert = alerts.find((a) => a.title.includes("awaiting review"));
    expect(reviewAlert).toBeDefined();
    expect(reviewAlert!.severity).toBe("warning");
  });

  it("respects repoFilter and skips repos not in the list", async () => {
    const fetch = buildFetch({
      checkRuns: [{ name: "build", conclusion: "failure" }],
    });
    vi.spyOn(global, "fetch").mockImplementation(fetch);

    // Only allow acme/web; acme/api should be skipped
    const alerts = await pollGitHub("tok", "acme", {
      repoFilter: ["acme/web"],
      stale_pr: { enabled: false, days: 3 },
      unreviewed_pr: { enabled: false, hours: 24 },
    });

    // Should only produce a CI alert for web, not api
    expect(alerts.every((a) => a.title.includes("web"))).toBe(true);
    expect(alerts.some((a) => a.title.includes("api"))).toBe(false);
  });

  it("skips stale PR check when stale_pr.enabled is false", async () => {
    const oldDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const fetch = buildFetch({
      checkRuns: [],
      prs: [
        { number: 4, title: "Old PR", draft: false, updated_at: oldDate, created_at: oldDate, requested_reviewers: [] },
      ],
    });
    vi.spyOn(global, "fetch").mockImplementation(fetch);

    const alerts = await pollGitHub("tok", "acme", {
      stale_pr: { enabled: false, days: 3 },
      failed_ci: { enabled: false },
      unreviewed_pr: { enabled: false, hours: 24 },
    });

    expect(alerts).toEqual([]);
  });
});
