/**
 * Unit tests for NetlifyProvider — mocks fetch and validates the request
 * shape (URL, method, headers, body) plus the response parser.
 *
 * These catch:
 *  - URL construction bugs (wrong endpoint, missing encodeURIComponent)
 *  - Auth header omissions
 *  - Response shape assumptions that don't match Netlify's actual API
 *  - State mapping mistakes (error vs building vs ready)
 *
 * They do NOT catch Netlify API changes on their end — for that you need
 * real integration tests against a live Netlify token.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NetlifyProvider } from "../netlify";

type FetchMock = ReturnType<typeof vi.fn>;
let fetchMock: FetchMock;
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const baseConfig = {
  service: "netlify" as const,
  token: "nfp_test_token_abc",
  siteId: "site-uuid-1234",
  projectName: "my-site",
};

function makeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

describe("NetlifyProvider constructor", () => {
  it("sets service = 'netlify'", () => {
    const p = new NetlifyProvider(baseConfig);
    expect(p.service).toBe("netlify");
  });

  it("throws when service doesn't match", () => {
    expect(() => new NetlifyProvider({ ...baseConfig, service: "vercel" as "netlify" })).toThrow(/NetlifyProvider cannot handle/);
  });

  it("throws when siteId is missing", () => {
    expect(() => new NetlifyProvider({ ...baseConfig, siteId: undefined })).toThrow(/requires config.siteId/);
  });
});

describe("NetlifyProvider.getLastSuccessfulDeploy", () => {
  it("calls correct URL with auth header", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse([]));

    const p = new NetlifyProvider(baseConfig);
    await p.getLastSuccessfulDeploy();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.netlify.com/api/v1/sites/site-uuid-1234/deploys?per_page=20");
    expect((opts as RequestInit).headers).toMatchObject({
      Authorization: "Bearer nfp_test_token_abc",
    });
  });

  it("URL-encodes the siteId", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse([]));
    const p = new NetlifyProvider({ ...baseConfig, siteId: "site/with slash" });
    await p.getLastSuccessfulDeploy();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("site%2Fwith%20slash");
  });

  it("returns first ready production deploy", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse([
        { id: "building-123", state: "building", context: "production", created_at: "2026-04-10T12:00:00Z" },
        { id: "ready-456", state: "ready", context: "production", ssl_url: "https://my-site.netlify.app", created_at: "2026-04-09T12:00:00Z", commit_ref: "abc123def", branch: "main" },
        { id: "ready-older", state: "ready", context: "production", ssl_url: "https://my-site.netlify.app", created_at: "2026-04-08T12:00:00Z" },
      ]),
    );

    const p = new NetlifyProvider(baseConfig);
    const result = await p.getLastSuccessfulDeploy();

    expect(result).not.toBeNull();
    expect(result!.id).toBe("ready-456");
    expect(result!.url).toBe("https://my-site.netlify.app");
    expect(result!.state).toBe("ready");
    expect(result!.commitSha).toBe("abc123def");
    expect(result!.meta?.branch).toBe("main");
  });

  it("skips preview deploys", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse([
        { id: "preview-1", state: "ready", context: "deploy-preview", ssl_url: "https://preview.netlify.app", created_at: "2026-04-10T12:00:00Z" },
        { id: "prod-1", state: "ready", context: "production", ssl_url: "https://my-site.netlify.app", created_at: "2026-04-09T12:00:00Z" },
      ]),
    );

    const p = new NetlifyProvider(baseConfig);
    const result = await p.getLastSuccessfulDeploy();
    expect(result!.id).toBe("prod-1");
  });

  it("returns null on HTTP error", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ error: "unauthorized" }, false, 401));
    const p = new NetlifyProvider(baseConfig);
    expect(await p.getLastSuccessfulDeploy()).toBeNull();
  });

  it("maps state correctly", async () => {
    const cases: Array<[string, string]> = [
      ["ready", "ready"],
      ["error", "error"],
      ["building", "building"],
      ["enqueued", "building"],
      ["new", "building"],
      ["some-new-state", "unknown"],
    ];
    for (const [input, expected] of cases) {
      fetchMock.mockResolvedValueOnce(
        makeResponse([{ id: "d1", state: input, context: "production", ssl_url: "x", created_at: "2026-04-10T12:00:00Z" }]),
      );
      const p = new NetlifyProvider(baseConfig);
      const result = await p.getLastSuccessfulDeploy();
      // Only "ready" returns a result — others are filtered out
      if (expected === "ready") expect(result?.state).toBe("ready");
      else expect(result).toBeNull();
    }
  });
});

describe("NetlifyProvider.rollbackToDeployment", () => {
  it("POSTs to /restore endpoint with deploy ID", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ id: "ready-456", ssl_url: "https://my-site.netlify.app" }),
    );

    const p = new NetlifyProvider(baseConfig);
    const result = await p.rollbackToDeployment("ready-456");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.netlify.com/api/v1/sites/site-uuid-1234/deploys/ready-456/restore");
    expect((opts as RequestInit).method).toBe("POST");
    expect((opts as RequestInit).headers).toMatchObject({
      Authorization: "Bearer nfp_test_token_abc",
    });

    expect(result).toEqual({
      deploymentId: "ready-456",
      url: "https://my-site.netlify.app",
    });
  });

  it("URL-encodes the deployment ID", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ id: "x", ssl_url: "x" }));
    const p = new NetlifyProvider(baseConfig);
    await p.rollbackToDeployment("id with/special");
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("id%20with%2Fspecial");
  });

  it("throws on HTTP error with status and response body", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse("Deploy not found", false, 404));
    const p = new NetlifyProvider(baseConfig);
    await expect(p.rollbackToDeployment("missing")).rejects.toThrow(/Netlify rollback failed \(404\).*Deploy not found/);
  });
});

describe("NetlifyProvider.getBuildLogs", () => {
  it("fetches from /deploys/:id/log", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse("line 1\nline 2\nbuild passed"),
    );

    const p = new NetlifyProvider(baseConfig);
    const logs = await p.getBuildLogs("deploy-123");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.netlify.com/api/v1/deploys/deploy-123/log");
    expect((opts as RequestInit).headers).toMatchObject({ Authorization: "Bearer nfp_test_token_abc" });
    expect(logs).toContain("build passed");
  });

  it("returns window around first error line", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `log line ${i}`);
    lines[50] = "Error: Module not found: foo";
    fetchMock.mockResolvedValueOnce(makeResponse(lines.join("\n")));

    const p = new NetlifyProvider(baseConfig);
    const logs = await p.getBuildLogs("d1");

    expect(logs).toContain("Error: Module not found");
    expect(logs).toContain("log line 40"); // 10 before
    expect(logs).toContain("log line 95"); // up to 50 after
    expect(logs).not.toContain("log line 0"); // way before error
  });

  it("falls back to last 50 lines when no error found", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `normal output ${i}`);
    fetchMock.mockResolvedValueOnce(makeResponse(lines.join("\n")));
    const p = new NetlifyProvider(baseConfig);
    const logs = await p.getBuildLogs("d1");
    expect(logs).toContain("normal output 99");
    expect(logs).not.toContain("normal output 0");
  });

  it("returns null on HTTP error", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({}, false, 404));
    const p = new NetlifyProvider(baseConfig);
    expect(await p.getBuildLogs("missing")).toBeNull();
  });
});

describe("NetlifyProvider.checkPermissions", () => {
  it("returns true when site is accessible", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ id: "site-uuid-1234" }));
    const p = new NetlifyProvider(baseConfig);
    expect(await p.checkPermissions()).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.netlify.com/api/v1/sites/site-uuid-1234");
  });

  it("returns false on 401/404", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({}, false, 401));
    const p = new NetlifyProvider(baseConfig);
    expect(await p.checkPermissions()).toBe(false);
  });
});
