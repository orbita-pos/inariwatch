/**
 * Unit tests for RenderProvider.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RenderProvider } from "../render";

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
  service: "render" as const,
  token: "rnd_test_token",
  serviceId: "srv-abc123",
  projectName: "my-api",
};

function makeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

describe("RenderProvider constructor", () => {
  it("throws when service mismatches", () => {
    expect(() => new RenderProvider({ ...baseConfig, service: "netlify" as "render" })).toThrow(/cannot handle/);
  });

  it("throws when serviceId missing", () => {
    expect(() => new RenderProvider({ ...baseConfig, serviceId: undefined })).toThrow(/requires config.serviceId/);
  });

  it("sets service = 'render'", () => {
    expect(new RenderProvider(baseConfig).service).toBe("render");
  });
});

describe("RenderProvider.getLastSuccessfulDeploy", () => {
  it("calls /deploys with limit=20 + bearer auth", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse([]));

    const p = new RenderProvider(baseConfig);
    await p.getLastSuccessfulDeploy();

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.render.com/v1/services/srv-abc123/deploys?limit=20");
    expect((opts as RequestInit).headers).toMatchObject({
      Authorization: "Bearer rnd_test_token",
      Accept: "application/json",
    });
  });

  it("URL-encodes serviceId", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse([]));
    const p = new RenderProvider({ ...baseConfig, serviceId: "srv/with spaces" });
    await p.getLastSuccessfulDeploy();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("srv%2Fwith%20spaces");
  });

  it("returns first live deploy", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse([
        { deploy: { id: "dep-failed", status: "build_failed", createdAt: "2026-04-10T12:00:00Z" } },
        { deploy: { id: "dep-live", status: "live", createdAt: "2026-04-09T12:00:00Z", commit: { id: "sha123" } } },
        { deploy: { id: "dep-older-live", status: "live", createdAt: "2026-04-08T12:00:00Z" } },
      ]),
    );

    const p = new RenderProvider(baseConfig);
    const result = await p.getLastSuccessfulDeploy();

    expect(result).not.toBeNull();
    expect(result!.id).toBe("dep-live");
    expect(result!.url).toBe("https://my-api.onrender.com");
    expect(result!.state).toBe("ready");
    expect(result!.commitSha).toBe("sha123");
  });

  it("maps Render statuses correctly", async () => {
    const cases: Array<[string, string]> = [
      ["live", "ready"],
      ["build_failed", "error"],
      ["update_failed", "error"],
      ["pre_deploy_failed", "error"],
      ["canceled", "canceled"],
      ["deactivated", "canceled"],
      ["build_in_progress", "building"],
      ["update_in_progress", "building"],
      ["created", "building"],
      ["some-new-status", "unknown"],
    ];

    for (const [input, expected] of cases) {
      fetchMock.mockResolvedValueOnce(
        makeResponse([{ deploy: { id: "d1", status: input, createdAt: "2026-04-10T12:00:00Z" } }]),
      );
      const p = new RenderProvider(baseConfig);
      const result = await p.getLastSuccessfulDeploy();
      if (expected === "ready") expect(result?.state).toBe("ready");
      else expect(result).toBeNull();
    }
  });

  it("returns null on HTTP error", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({}, false, 401));
    const p = new RenderProvider(baseConfig);
    expect(await p.getLastSuccessfulDeploy()).toBeNull();
  });

  it("returns null when response is not an array", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ error: "bad" }));
    const p = new RenderProvider(baseConfig);
    expect(await p.getLastSuccessfulDeploy()).toBeNull();
  });
});

describe("RenderProvider.rollbackToDeployment", () => {
  it("POSTs to /rollback with { deployId } in body", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ id: "dep-restored", status: "build_in_progress", createdAt: "2026-04-11T12:00:00Z" }),
    );

    const p = new RenderProvider(baseConfig);
    const result = await p.rollbackToDeployment("dep-target");

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.render.com/v1/services/srv-abc123/rollback");
    expect((opts as RequestInit).method).toBe("POST");
    expect((opts as RequestInit).body).toBe(JSON.stringify({ deployId: "dep-target" }));
    expect((opts as RequestInit).headers).toMatchObject({
      Authorization: "Bearer rnd_test_token",
      "Content-Type": "application/json",
    });

    expect(result.deploymentId).toBe("dep-restored");
    expect(result.url).toBe("https://my-api.onrender.com");
  });

  it("throws on HTTP error", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse("not found", false, 404));
    const p = new RenderProvider(baseConfig);
    await expect(p.rollbackToDeployment("d")).rejects.toThrow(/Render rollback failed \(404\).*not found/);
  });
});

describe("RenderProvider.getBuildLogs", () => {
  it("returns null — Render API has no build log endpoint", async () => {
    const p = new RenderProvider(baseConfig);
    const logs = await p.getBuildLogs("any-deploy-id");
    expect(logs).toBeNull();
    // Crucially, no HTTP call should be made
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("RenderProvider.checkPermissions", () => {
  it("returns true when service is accessible", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ id: "srv-abc123" }));
    const p = new RenderProvider(baseConfig);
    expect(await p.checkPermissions()).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.render.com/v1/services/srv-abc123");
  });

  it("returns false on 401", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({}, false, 401));
    const p = new RenderProvider(baseConfig);
    expect(await p.checkPermissions()).toBe(false);
  });
});
