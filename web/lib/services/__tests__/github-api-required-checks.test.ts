/**
 * Tests for getRequiredStatusChecks + the `requiredChecks` filter on
 * getCheckRunsStatus. These are the two pieces that power the
 * "first required check" CI-wait strategy in remediate.ts.
 *
 * We mock global.fetch since the module uses native fetch via an
 * internal ghFetch wrapper. No DB / redis involved.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { getRequiredStatusChecks, getCheckRunsStatus } from "../github-api";

const ORIGINAL_FETCH = globalThis.fetch;

function mockFetch(fn: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return Promise.resolve(fn(url, init));
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  mockFetch(() => new Response("unhandled", { status: 500 }));
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

// ── getRequiredStatusChecks ────────────────────────────────────────────────

describe("getRequiredStatusChecks", () => {
  it("returns null when the branch has no protection rules (404)", async () => {
    mockFetch(() => new Response("Branch not protected", { status: 404 }));
    const out = await getRequiredStatusChecks("t", "owner", "repo", "main");
    expect(out).toBeNull();
  });

  it("returns null on 403 (permission denied)", async () => {
    mockFetch(() => new Response("Forbidden", { status: 403 }));
    const out = await getRequiredStatusChecks("t", "owner", "repo", "main");
    expect(out).toBeNull();
  });

  it("returns [] when protection exists but required_status_checks is null", async () => {
    mockFetch(() => jsonResponse({ required_status_checks: null }));
    const out = await getRequiredStatusChecks("t", "owner", "repo", "main");
    expect(out).toEqual([]);
  });

  it("returns contexts from the legacy `contexts` field", async () => {
    mockFetch(() => jsonResponse({
      required_status_checks: {
        strict: false,
        contexts: ["build-and-test", "lint"],
      },
    }));
    const out = await getRequiredStatusChecks("t", "owner", "repo", "main");
    expect(out).toEqual(["build-and-test", "lint"]);
  });

  it("merges contexts from both `contexts` and `checks` without duplicates", async () => {
    mockFetch(() => jsonResponse({
      required_status_checks: {
        strict: true,
        contexts: ["build-and-test"],
        checks: [
          { context: "build-and-test", app_id: 1 }, // duplicate
          { context: "security-audit", app_id: 2 },
        ],
      },
    }));
    const out = await getRequiredStatusChecks("t", "owner", "repo", "main");
    expect(out).toEqual(expect.arrayContaining(["build-and-test", "security-audit"]));
    expect(out).toHaveLength(2);
  });

  it("tolerates a malformed response body (non-JSON)", async () => {
    mockFetch(() => new Response("not json", { status: 200 }));
    const out = await getRequiredStatusChecks("t", "owner", "repo", "main");
    expect(out).toBeNull();
  });

  it("URL-encodes the branch name", async () => {
    let seenUrl = "";
    mockFetch((url) => {
      seenUrl = url;
      return jsonResponse({ required_status_checks: { contexts: [] } });
    });
    await getRequiredStatusChecks("t", "owner", "repo", "feature/new work");
    expect(seenUrl).toContain("feature%2Fnew%20work");
  });
});

// ── getCheckRunsStatus with requiredChecks ─────────────────────────────────

describe("getCheckRunsStatus with requiredChecks filter", () => {
  it("returns `success` when all REQUIRED checks pass, even if an optional check is still running", async () => {
    mockFetch(() => jsonResponse({
      total_count: 3,
      check_runs: [
        { name: "build-and-test", status: "completed", conclusion: "success" },
        { name: "lint",           status: "completed", conclusion: "success" },
        { name: "coverage",       status: "in_progress", conclusion: null }, // optional, still running
      ],
    }));

    const out = await getCheckRunsStatus("t", "owner", "repo", "sha", ["build-and-test", "lint"]);
    expect(out.status).toBe("success");
    // Optional check stays visible in details for UI
    expect(out.details.some((d) => d.name === "coverage")).toBe(true);
  });

  it("returns `failure` when a required check failed, even if optional passes", async () => {
    mockFetch(() => jsonResponse({
      total_count: 2,
      check_runs: [
        { name: "build-and-test", status: "completed", conclusion: "failure" },
        { name: "coverage",       status: "completed", conclusion: "success" },
      ],
    }));

    const out = await getCheckRunsStatus("t", "owner", "repo", "sha", ["build-and-test"]);
    expect(out.status).toBe("failure");
  });

  it("returns `in_progress` when a required check is still running", async () => {
    mockFetch(() => jsonResponse({
      total_count: 2,
      check_runs: [
        { name: "build-and-test", status: "in_progress", conclusion: null },
        { name: "coverage",       status: "completed",   conclusion: "success" },
      ],
    }));

    const out = await getCheckRunsStatus("t", "owner", "repo", "sha", ["build-and-test"]);
    expect(out.status).toBe("in_progress");
  });

  it("returns `pending` when the required checks have not reported yet", async () => {
    mockFetch(() => jsonResponse({
      total_count: 1,
      check_runs: [
        { name: "coverage", status: "completed", conclusion: "success" },
      ],
    }));

    // requiredChecks includes `build-and-test`, which hasn't shown up.
    const out = await getCheckRunsStatus("t", "owner", "repo", "sha", ["build-and-test"]);
    expect(out.status).toBe("pending");
    // `details` still shows the optional check
    expect(out.details).toHaveLength(1);
  });

  it("falls back to 'wait for all' when requiredChecks is null (legacy behavior)", async () => {
    mockFetch(() => jsonResponse({
      total_count: 2,
      check_runs: [
        { name: "build-and-test", status: "completed",   conclusion: "success" },
        { name: "coverage",       status: "in_progress", conclusion: null },
      ],
    }));

    // Old callers pass no requiredChecks → verdict waits for ALL checks.
    const out = await getCheckRunsStatus("t", "owner", "repo", "sha");
    expect(out.status).toBe("in_progress");
  });

  it("falls back to 'wait for all' when requiredChecks is an empty array", async () => {
    mockFetch(() => jsonResponse({
      total_count: 2,
      check_runs: [
        { name: "build-and-test", status: "completed",   conclusion: "success" },
        { name: "coverage",       status: "in_progress", conclusion: null },
      ],
    }));

    const out = await getCheckRunsStatus("t", "owner", "repo", "sha", []);
    expect(out.status).toBe("in_progress");
  });

  it("returns 'pending' when no checks have reported yet (existing behavior)", async () => {
    mockFetch(() => jsonResponse({ total_count: 0, check_runs: [] }));
    const out = await getCheckRunsStatus("t", "owner", "repo", "sha", null);
    expect(out.status).toBe("pending");
  });
});
