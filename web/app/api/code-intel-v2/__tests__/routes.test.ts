/**
 * Phase 1.6 — /api/code-intel-v2/{find-references, type-at, blast-radius}.
 * Verifies auth, body validation, dispatch to queries.ts, and 404 path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_BACKUP = process.env.CRON_SECRET;

vi.mock("@/lib/code-intelligence-v2/queries", () => ({
  findReferences: vi.fn(async () => [
    { id: "r1", filePath: "src/b.ts", line: 4, kind: "call" },
    { id: "r2", filePath: "src/b.ts", line: 9, kind: "call" },
  ]),
  typeAt: vi.fn(async (filePath: string, line: number) => {
    // Sentinel: line === 9999 → not found. Otherwise return enriched type.
    if (line === 9999) return null;
    return { type: "Promise<User>", symbol: { id: "s1", filePath, startLine: line } };
  }),
  blastRadius: vi.fn(async (_fqn: string, _repoId: string, depth?: number) => ({
    symbols: [{ id: "s2", fqn: "x" }],
    depth: depth ?? 2,
  })),
}));

vi.mock("@/lib/services/code-intelligence.service", () => ({
  firstReadyRepoForProject: vi.fn(async (projectId: string) => {
    if (projectId === "p1") return "r1";
    return null;
  }),
}));

import { POST as findReferencesPOST } from "../find-references/route";
import { POST as typeAtPOST } from "../type-at/route";
import { POST as blastRadiusPOST } from "../blast-radius/route";

beforeEach(() => {
  process.env.CRON_SECRET = "test-secret";
});

afterEach(() => {
  if (ENV_BACKUP === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ENV_BACKUP;
});

function makeReq(url: string, headers: Record<string, string>, body: unknown): import("next/server").NextRequest {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

describe("auth", () => {
  it("rejects without Bearer", async () => {
    const res = await findReferencesPOST(makeReq("http://x/api", {}, { symbolFqn: "x" }));
    expect(res.status).toBe(401);
  });

  it("rejects bad secret", async () => {
    const res = await findReferencesPOST(makeReq("http://x/api", { authorization: "Bearer wrong" }, { symbolFqn: "x" }));
    expect(res.status).toBe(401);
  });
});

describe("find-references", () => {
  const auth = { authorization: "Bearer test-secret" };

  it("returns refs for a known project", async () => {
    const res = await findReferencesPOST(
      makeReq("http://x/api", auth, { projectId: "p1", symbolFqn: "src/a.ts::foo" }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.references.length).toBe(2);
    expect(json.totalFound).toBe(2);
    expect(json.repoId).toBe("r1");
  });

  it("404 when project has no ready v2 repo", async () => {
    const res = await findReferencesPOST(
      makeReq("http://x/api", auth, { projectId: "missing", symbolFqn: "x" }),
    );
    expect(res.status).toBe(404);
  });

  it("400 when symbolFqn missing", async () => {
    const res = await findReferencesPOST(
      makeReq("http://x/api", auth, { projectId: "p1" }),
    );
    expect(res.status).toBe(400);
  });

  it("respects limit (cap 200)", async () => {
    const res = await findReferencesPOST(
      makeReq("http://x/api", auth, { projectId: "p1", symbolFqn: "x", limit: 1 }),
    );
    const json = await res.json();
    expect(json.references.length).toBe(1);
    expect(json.truncated).toBe(true);
  });
});

describe("type-at", () => {
  const auth = { authorization: "Bearer test-secret" };

  it("returns enriched type info", async () => {
    const res = await typeAtPOST(
      makeReq("http://x/api", auth, { projectId: "p1", filePath: "src/a.ts", line: 10, col: 0 }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.type).toBe("Promise<User>");
    expect(json.symbol.startLine).toBe(10);
  });

  it("returns null type when query yields no symbol", async () => {
    const res = await typeAtPOST(
      makeReq("http://x/api", auth, { projectId: "p1", filePath: "src/a.ts", line: 9999 }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.type).toBeNull();
    expect(json.symbol).toBeNull();
  });

  it("400 when filePath / line invalid", async () => {
    const res = await typeAtPOST(
      makeReq("http://x/api", auth, { projectId: "p1", line: 1 }),
    );
    expect(res.status).toBe(400);
  });
});

describe("blast-radius", () => {
  const auth = { authorization: "Bearer test-secret" };

  it("forwards depth to queries.blastRadius", async () => {
    const res = await blastRadiusPOST(
      makeReq("http://x/api", auth, { projectId: "p1", symbolFqn: "x", depth: 4 }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.depth).toBe(4);
    expect(json.count).toBe(1);
  });

  it("uses default depth when omitted", async () => {
    const res = await blastRadiusPOST(
      makeReq("http://x/api", auth, { projectId: "p1", symbolFqn: "x" }),
    );
    const json = await res.json();
    expect(json.depth).toBe(2);
  });

  it("400 when symbolFqn missing", async () => {
    const res = await blastRadiusPOST(
      makeReq("http://x/api", auth, { projectId: "p1" }),
    );
    expect(res.status).toBe(400);
  });
});
