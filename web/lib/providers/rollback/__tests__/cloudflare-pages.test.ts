/**
 * Unit tests for CloudflarePagesProvider — mocks fetch and validates the
 * request shape plus response parser. See netlify.test.ts for the rationale.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CloudflarePagesProvider } from "../cloudflare-pages";

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
  service: "cloudflare-pages" as const,
  token: "cf_token_xyz",
  accountId: "acc-123",
  projectName: "my-project",
};

function makeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function cfOk<T>(result: T) {
  return { success: true, errors: [], messages: [], result };
}

function cfFail(message = "error") {
  return { success: false, errors: [{ code: 1, message }], messages: [], result: null };
}

describe("CloudflarePagesProvider constructor", () => {
  it("throws when service doesn't match", () => {
    expect(() => new CloudflarePagesProvider({ ...baseConfig, service: "vercel" as "cloudflare-pages" })).toThrow(/cannot handle/);
  });

  it("throws when accountId is missing", () => {
    expect(() => new CloudflarePagesProvider({ ...baseConfig, accountId: undefined })).toThrow(/requires config.accountId/);
  });

  it("sets service = 'cloudflare-pages'", () => {
    expect(new CloudflarePagesProvider(baseConfig).service).toBe("cloudflare-pages");
  });
});

describe("CloudflarePagesProvider.getLastSuccessfulDeploy", () => {
  it("calls correct URL with bearer auth", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(cfOk([])));

    const p = new CloudflarePagesProvider(baseConfig);
    await p.getLastSuccessfulDeploy();

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acc-123/pages/projects/my-project/deployments?env=production");
    expect((opts as RequestInit).headers).toMatchObject({ Authorization: "Bearer cf_token_xyz" });
  });

  it("URL-encodes accountId and projectName", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(cfOk([])));
    const p = new CloudflarePagesProvider({ ...baseConfig, accountId: "acc/123", projectName: "my project" });
    await p.getLastSuccessfulDeploy();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("acc%2F123");
    expect(url).toContain("my%20project");
  });

  it("returns first ready deploy in production env", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(
        cfOk([
          {
            id: "dep-old",
            environment: "production",
            created_on: "2026-04-08T12:00:00Z",
            url: "https://old.pages.dev",
            latest_stage: { name: "deploy", status: "success" },
            deployment_trigger: { metadata: { commit_hash: "abc", branch: "main" } },
          },
          {
            id: "dep-preview",
            environment: "preview",
            created_on: "2026-04-09T12:00:00Z",
            url: "https://preview.pages.dev",
            latest_stage: { name: "deploy", status: "success" },
          },
        ]),
      ),
    );

    const p = new CloudflarePagesProvider(baseConfig);
    const result = await p.getLastSuccessfulDeploy();
    expect(result).not.toBeNull();
    expect(result!.id).toBe("dep-old");
    expect(result!.url).toBe("https://old.pages.dev");
    expect(result!.state).toBe("ready");
    expect(result!.commitSha).toBe("abc");
    expect(result!.meta?.environment).toBe("production");
    expect(result!.meta?.branch).toBe("main");
  });

  it("maps stage states correctly", async () => {
    const cases: Array<[{ name: string; status: string }, string]> = [
      [{ name: "deploy", status: "success" }, "ready"],
      [{ name: "build", status: "failure" }, "error"],
      [{ name: "build", status: "canceled" }, "canceled"],
      [{ name: "build", status: "active" }, "building"],
      [{ name: "build", status: "idle" }, "building"],
      [{ name: "build", status: "some-unknown-status" }, "unknown"],
    ];

    for (const [stage, expected] of cases) {
      fetchMock.mockResolvedValueOnce(
        makeResponse(cfOk([{ id: "d", environment: "production", created_on: "2026-04-10T12:00:00Z", latest_stage: stage }])),
      );
      const p = new CloudflarePagesProvider(baseConfig);
      const result = await p.getLastSuccessfulDeploy();
      if (expected === "ready") expect(result?.state).toBe("ready");
      else expect(result).toBeNull();
    }
  });

  it("returns null on API error response", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(cfFail("not authorized"), true, 200));
    const p = new CloudflarePagesProvider(baseConfig);
    expect(await p.getLastSuccessfulDeploy()).toBeNull();
  });

  it("returns null on HTTP error", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({}, false, 404));
    const p = new CloudflarePagesProvider(baseConfig);
    expect(await p.getLastSuccessfulDeploy()).toBeNull();
  });
});

describe("CloudflarePagesProvider.rollbackToDeployment", () => {
  it("POSTs to rollback endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(
        cfOk({
          id: "dep-restored",
          environment: "production",
          created_on: "2026-04-11T12:00:00Z",
          url: "https://restored.pages.dev",
          latest_stage: { name: "deploy", status: "success" },
        }),
      ),
    );

    const p = new CloudflarePagesProvider(baseConfig);
    const result = await p.rollbackToDeployment("dep-old-123");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acc-123/pages/projects/my-project/deployments/dep-old-123/rollback");
    expect((opts as RequestInit).method).toBe("POST");
    expect(result.deploymentId).toBe("dep-restored");
    expect(result.url).toBe("https://restored.pages.dev");
  });

  it("throws on HTTP error with body", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse("bad request", false, 400));
    const p = new CloudflarePagesProvider(baseConfig);
    await expect(p.rollbackToDeployment("d")).rejects.toThrow(/Cloudflare Pages rollback failed \(400\).*bad request/);
  });

  it("throws on API success=false", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(cfFail("quota exceeded")));
    const p = new CloudflarePagesProvider(baseConfig);
    await expect(p.rollbackToDeployment("d")).rejects.toThrow(/unsuccessful response/);
  });
});

describe("CloudflarePagesProvider.getBuildLogs", () => {
  it("fetches history/logs endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(
        cfOk({
          data: [
            { line: "building..." },
            { line: "✓ compiled" },
          ],
        }),
      ),
    );

    const p = new CloudflarePagesProvider(baseConfig);
    const logs = await p.getBuildLogs("dep-1");

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acc-123/pages/projects/my-project/deployments/dep-1/history/logs");
    expect(logs).toContain("compiled");
  });

  it("returns window around error line", async () => {
    const lines = Array.from({ length: 80 }, (_, i) => ({ line: `log ${i}` }));
    lines[30] = { line: "Error: Module not found: foo" };
    fetchMock.mockResolvedValueOnce(makeResponse(cfOk({ data: lines })));

    const p = new CloudflarePagesProvider(baseConfig);
    const logs = await p.getBuildLogs("d");
    expect(logs).toContain("Error: Module not found");
    expect(logs).toContain("log 25"); // ~10 before
    expect(logs).toContain("log 75"); // ~50 after (or close)
  });

  it("returns null when data array is missing", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(cfOk({ data: [] })));
    const p = new CloudflarePagesProvider(baseConfig);
    expect(await p.getBuildLogs("d")).toBeNull();
  });

  it("returns null on HTTP error", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({}, false, 404));
    const p = new CloudflarePagesProvider(baseConfig);
    expect(await p.getBuildLogs("d")).toBeNull();
  });
});

describe("CloudflarePagesProvider.checkPermissions", () => {
  it("returns true when project is accessible", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(cfOk({})));
    const p = new CloudflarePagesProvider(baseConfig);
    expect(await p.checkPermissions()).toBe(true);
  });

  it("returns false on HTTP error", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({}, false, 401));
    const p = new CloudflarePagesProvider(baseConfig);
    expect(await p.checkPermissions()).toBe(false);
  });
});
