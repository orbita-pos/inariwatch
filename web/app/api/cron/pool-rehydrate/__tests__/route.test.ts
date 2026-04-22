/**
 * Tests for /api/cron/pool-rehydrate — Fase 2b warm-pool maintenance cron.
 *
 * Mocks the DB query that lists active projects and the fetch call to
 * the Go server's /pool/warm endpoint. Verifies auth, the disabled /
 * unconfigured fast-paths, the outcome aggregation, and that pool-full
 * (409) is NOT counted as an error.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock @/lib/db before importing the route so the route picks up the
// mocked db.execute. Tests set the mock's return value per-case.
const executeMock = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    execute: executeMock,
  },
}));

// cron-utils.pingCronHealth writes to Redis — stub it so tests don't need
// the redis module. cronLog just logs to stderr; leave real.
vi.mock("@/lib/cron-utils", async (orig) => {
  const real = await orig<typeof import("@/lib/cron-utils")>();
  return {
    ...real,
    pingCronHealth: vi.fn(async () => {}),
  };
});

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { ...process.env };

function makeReq(authHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers.authorization = authHeader;
  return new Request("http://test.local/api/cron/pool-rehydrate", { headers });
}

function setEnv(overrides: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("/api/cron/pool-rehydrate", () => {
  beforeEach(() => {
    // The route captures env into module-scoped constants (e.g.
    // `const CRON_SECRET = process.env.CRON_SECRET`). Reset the module
    // cache so each test's env state is the one the route sees.
    vi.resetModules();
    executeMock.mockReset();
    setEnv({
      CRON_SECRET: "test-cron-secret",
      CONTAINER_POOL_ENABLED: "true",
      STAGING_SERVER_URL: "https://api.staging.inariwatch.com",
      STAGING_API_SECRET: "staging-secret",
    });
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    // Restore env from snapshot so tests don't bleed
    for (const k of Object.keys(process.env)) {
      if (!(k in ORIGINAL_ENV)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
      if (v !== undefined) process.env[k] = v;
    }
  });

  // ── Auth ───────────────────────────────────────────────────────────────

  it("returns 401 when CRON_SECRET is unset", async () => {
    setEnv({ CRON_SECRET: undefined });
    const { GET } = await import("../route");
    const res = await GET(makeReq("Bearer anything"));
    expect(res.status).toBe(401);
  });

  it("returns 401 when Authorization header is missing", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it("returns 401 when the Bearer token is wrong", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeReq("Bearer wrong-secret"));
    expect(res.status).toBe(401);
  });

  // ── Kill switch + unconfigured paths ──────────────────────────────────

  it("skips with 'pool disabled' when CONTAINER_POOL_ENABLED is not 'true'", async () => {
    setEnv({ CONTAINER_POOL_ENABLED: "false" });
    const { GET } = await import("../route");
    const res = await GET(makeReq("Bearer test-cron-secret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.skipped).toBe("pool disabled");
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("skips with 'staging not configured' when STAGING_SERVER_URL is missing", async () => {
    setEnv({ STAGING_SERVER_URL: undefined });
    const { GET } = await import("../route");
    const res = await GET(makeReq("Bearer test-cron-secret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe("staging not configured");
  });

  // ── Outcome aggregation ───────────────────────────────────────────────

  it("calls /pool/warm for every active project with repo+branch", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        { project_id: "p1", repo: "owner/repo-a", default_branch: "main", session_count: "10" },
        { project_id: "p2", repo: "owner/repo-b", default_branch: "dev", session_count: "5" },
      ],
    });

    const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      fetchCalls.push({ url: String(input), body });
      return new Response(JSON.stringify({ container_id: "c", status: "ready" }), {
        status: 201,
      });
    }) as typeof fetch;

    const { GET } = await import("../route");
    const res = await GET(makeReq("Bearer test-cron-secret"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.scanned).toBe(2);
    expect(json.warmed).toBe(2);
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]!.url).toBe("https://api.staging.inariwatch.com/pool/warm");
    expect(fetchCalls[0]!.body).toEqual({
      project_id: "p1",
      repo: "https://github.com/owner/repo-a.git",
      ref: "main",
    });
  });

  it("counts 409 (pool-full) as poolFull, NOT as error — expected once caps saturate", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        { project_id: "p1", repo: "owner/repo-a", default_branch: "main", session_count: "10" },
      ],
    });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "pool full" }), { status: 409 })) as typeof fetch;

    const { GET } = await import("../route");
    const res = await GET(makeReq("Bearer test-cron-secret"));
    const json = await res.json();
    expect(json.warmed).toBe(0);
    expect(json.poolFull).toBe(1);
    expect(json.errorCount).toBe(0);
  });

  it("counts non-201/409 statuses as errors with the response body truncated", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        { project_id: "p1", repo: "owner/repo-a", default_branch: "main", session_count: "10" },
      ],
    });
    globalThis.fetch = (async () =>
      new Response("boom-boom-boom-".repeat(50), { status: 500 })) as typeof fetch;

    const { GET } = await import("../route");
    const res = await GET(makeReq("Bearer test-cron-secret"));
    const json = await res.json();
    expect(json.warmed).toBe(0);
    expect(json.errorCount).toBe(1);
    expect(json.errors[0].httpStatus).toBe(500);
    expect(json.errors[0].reason.length).toBeLessThanOrEqual(200);
  });

  it("skips projects without a default repo or branch (no fetch call)", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        { project_id: "p1", repo: null, default_branch: "main", session_count: "10" },
        { project_id: "p2", repo: "owner/repo", default_branch: null, session_count: "5" },
      ],
    });
    const fetchSpy = vi.fn(async () => new Response("", { status: 201 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { GET } = await import("../route");
    const res = await GET(makeReq("Bearer test-cron-secret"));
    const json = await res.json();
    expect(json.skipped).toBe(2);
    expect(json.warmed).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("preserves a pre-built URL (http/https prefix) instead of prepending github.com", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          project_id: "p1",
          repo: "https://gitlab.example.com/group/repo.git",
          default_branch: "main",
          session_count: "1",
        },
      ],
    });
    let seenBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_input, init) => {
      seenBody = JSON.parse(String(init?.body));
      return new Response("", { status: 201 });
    }) as typeof fetch;

    const { GET } = await import("../route");
    await GET(makeReq("Bearer test-cron-secret"));
    expect(seenBody.repo).toBe("https://gitlab.example.com/group/repo.git");
  });
});
