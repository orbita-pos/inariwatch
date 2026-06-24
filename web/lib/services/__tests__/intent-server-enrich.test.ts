/**
 * Tests for `enrichEventIntentIfMissing` and the regex extractor it uses
 * (SKYNET §3 piece 20).
 *
 * The extractor is a pure function — covered with literal source-string
 * inputs. The orchestrator is exercised end-to-end with stubs for db,
 * Redis, and the GitHub API so we can assert the cache + skip semantics
 * without a live integration.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Silence expected warn noise (the orchestrator logs on GH errors) ──────
vi.spyOn(console, "warn").mockImplementation(() => undefined);

// ── Redis stub ────────────────────────────────────────────────────────────
const redisStore = new Map<string, unknown>();
const redisGet = vi.fn(async (key: string) => redisStore.get(key) ?? null);
const redisSet = vi.fn(
  async (key: string, value: unknown, _opts?: { ex?: number; nx?: boolean }) => {
    redisStore.set(key, value);
    return "OK" as const;
  },
);

vi.mock("@/lib/redis", () => ({
  getRedis: () => ({ get: redisGet, set: redisSet }),
}));

// ── DB stub: return a single GitHub integration row ───────────────────────
let dbIntegrations: Array<{ service: string; configEncrypted: string }> = [];

function mkSelectChain() {
  const obj: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "limit", "leftJoin", "innerJoin"]) {
    obj[m] = () => obj;
  }
  obj.then = (resolve: (v: unknown) => void) => resolve(dbIntegrations);
  return obj;
}

vi.mock("@/lib/db", () => ({
  db: { select: () => mkSelectChain() },
}));

vi.mock("@/lib/db/schema", () => ({
  projectIntegrations: {
    projectId: "project_id",
    service: "service",
    configEncrypted: "config_encrypted",
  },
}));

vi.mock("@/lib/crypto", () => ({
  decryptConfig: (raw: string) => JSON.parse(raw),
}));

// ── GitHub API stub ───────────────────────────────────────────────────────
const ghCalls: Array<[string, string, string, string, string | undefined]> = [];
let ghContent: string | null = null;
let ghThrow = false;

vi.mock("@/lib/services/github-api", () => ({
  getFileContent: vi.fn(
    async (token: string, owner: string, repo: string, path: string, ref?: string) => {
      ghCalls.push([token, owner, repo, path, ref]);
      if (ghThrow) throw new Error("simulated gh failure");
      return ghContent;
    },
  ),
}));

import { extractShape, stripRepoPrefix, enrichEventIntentIfMissing } from "../intent-server-enrich";

beforeEach(() => {
  redisStore.clear();
  redisGet.mockClear();
  redisSet.mockClear();
  ghCalls.length = 0;
  ghContent = null;
  ghThrow = false;
  dbIntegrations = [
    {
      service: "github",
      configEncrypted: JSON.stringify({ token: "ghp_test", owner: "octocat" }),
    },
  ];
});

// ─── extractShape: TypeScript interface ────────────────────────────────────
describe("extractShape — TS interfaces", () => {
  it("matches by symbol name", () => {
    const r = extractShape(
      `export interface CreateUserRequest {
         email: string;
         age?: number;
         tags: string[];
       }`,
      "CreateUserRequest",
    );
    expect(r).not.toBeNull();
    expect(r!._source).toBe("ts");
    expect(r!.shape.type).toBe("object");
    expect(r!.shape._symbol).toBe("CreateUserRequest");
    expect(r!.shape.properties).toBeDefined();
    expect(r!.shape.properties!.email.type).toBe("string");
    expect(r!.shape.properties!.age.type).toBe("number");
    expect(r!.shape.properties!.tags).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(r!.shape.required).toContain("email");
    expect(r!.shape.required).toContain("tags");
    expect(r!.shape.required).not.toContain("age");
  });

  it("falls back to first interface when symbol is null", () => {
    const r = extractShape(
      `export interface First { a: string }
       export interface Second { b: number }`,
      null,
    );
    expect(r!.shape._symbol).toBe("First");
  });

  it("returns null when symbol does not match anything", () => {
    const r = extractShape(`export interface Foo { a: string }`, "Bar");
    expect(r).toBeNull();
  });

  it("treats `T | undefined` as optional", () => {
    const r = extractShape(
      `interface Foo { a: string; b: number | undefined }`,
      "Foo",
    );
    expect(r!.shape.required).toContain("a");
    expect(r!.shape.required).not.toContain("b");
    expect(r!.shape.properties!.b.type).toBe("number");
  });

  it("collapses comments before matching", () => {
    const r = extractShape(
      `// interface Decoy { x: string }
       /* interface AlsoDecoy { y: number } */
       interface Real { z: boolean }`,
      "Real",
    );
    expect(r).not.toBeNull();
    expect(r!.shape._symbol).toBe("Real");
  });
});

describe("extractShape — TS type aliases", () => {
  it("handles type alias to object literal", () => {
    const r = extractShape(
      `export type Foo = { a: string; b?: number }`,
      "Foo",
    );
    expect(r!.shape.required).toEqual(["a"]);
    expect(r!.shape.properties!.b.type).toBe("number");
  });

  it("emits Date as date-time format", () => {
    const r = extractShape(`type Foo = { at: Date }`, "Foo");
    expect(r!.shape.properties!.at).toEqual({ type: "string", format: "date-time" });
  });

  it("preserves string literals as enum hints", () => {
    const r = extractShape(`type Foo = { role: "admin" }`, "Foo");
    expect(r!.shape.properties!.role).toEqual({ type: "string", enum: ["admin"] });
  });
});

describe("extractShape — Zod schemas", () => {
  it("extracts a basic z.object", () => {
    const r = extractShape(
      `export const userSchema = z.object({
         email: z.string().email(),
         age: z.number(),
         nickname: z.string().optional(),
       })`,
      "userSchema",
    );
    expect(r!._source).toBe("zod");
    expect(r!.shape.properties!.email).toEqual({ type: "string", format: "email" });
    expect(r!.shape.properties!.age.type).toBe("number");
    expect(r!.shape.properties!.nickname.type).toBe("string");
    expect(r!.shape.required).toContain("email");
    expect(r!.shape.required).not.toContain("nickname");
  });

  it("handles z.array, z.enum, z.literal", () => {
    const r = extractShape(
      `const s = z.object({
         tags: z.array(z.string()),
         role: z.enum(["admin","member"]),
         flag: z.literal(true),
       })`,
      "s",
    );
    expect(r!.shape.properties!.tags).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(r!.shape.properties!.role).toEqual({
      type: "string",
      enum: ["admin", "member"],
    });
    expect(r!.shape.properties!.flag).toEqual({ type: "boolean", enum: [true] });
  });
});

// ─── stripRepoPrefix ──────────────────────────────────────────────────────
describe("stripRepoPrefix", () => {
  it("returns repo-relative paths verbatim", () => {
    expect(stripRepoPrefix("src/handlers/user.ts", "octo", "myrepo")).toBe("src/handlers/user.ts");
  });

  it("strips absolute Linux paths up to the repo dir", () => {
    expect(stripRepoPrefix("/home/runner/work/myrepo/myrepo/src/api.ts", "octo", "myrepo"))
      .toBe("myrepo/src/api.ts");
  });

  it("strips absolute Windows paths and normalizes slashes", () => {
    expect(stripRepoPrefix("C:\\Users\\dev\\projects\\myrepo\\src\\api.ts", "octo", "myrepo"))
      .toBe("src/api.ts");
  });

  it("rejects node_modules paths", () => {
    expect(stripRepoPrefix("node_modules/foo/index.js", "octo", "myrepo")).toBeNull();
  });
});

// ─── enrichEventIntentIfMissing ───────────────────────────────────────────
describe("enrichEventIntentIfMissing — orchestrator", () => {
  function v2Event(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      schema_version: "2.0",
      git: { repo: "octocat/myrepo", commit: "deadbeefcafe1234" },
      evidence: {
        stack: [
          { file: "src/api/users.ts", line: 42, function: "CreateUserRequest" },
        ],
      },
      ...overrides,
    } as Record<string, unknown>;
  }

  it("attaches a contract on cache miss + GitHub success", async () => {
    ghContent = `export interface CreateUserRequest { email: string; age?: number }`;
    const event = v2Event();

    await enrichEventIntentIfMissing(event, "proj-1");

    const expected = event.expected as { contracts?: Array<{ source: string; shape: { _symbol?: string } }> };
    expect(expected?.contracts?.length).toBe(1);
    expect(expected!.contracts![0].source).toBe("ts");
    expect(expected!.contracts![0].shape._symbol).toBe("CreateUserRequest");
    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0][3]).toBe("src/api/users.ts");
    expect(ghCalls[0][4]).toBe("deadbeefcafe1234");
  });

  it("hits the positive cache on second call without re-fetching", async () => {
    ghContent = `interface CreateUserRequest { email: string }`;
    const e1 = v2Event();
    await enrichEventIntentIfMissing(e1, "proj-1");
    expect(ghCalls).toHaveLength(1);

    const e2 = v2Event();
    await enrichEventIntentIfMissing(e2, "proj-1");
    expect(ghCalls).toHaveLength(1); // still 1 — pulled from Redis
    expect((e2.expected as { contracts?: unknown[] }).contracts).toHaveLength(1);
  });

  it("respects negative cache on file 404", async () => {
    ghContent = null;
    const e1 = v2Event();
    await enrichEventIntentIfMissing(e1, "proj-1");
    expect(e1.expected).toBeUndefined();

    const e2 = v2Event();
    await enrichEventIntentIfMissing(e2, "proj-1");
    expect(ghCalls).toHaveLength(1); // negative cache prevents the second GH call
    expect(e2.expected).toBeUndefined();
  });

  it("skips when payload is v1", async () => {
    const event = v2Event({ schema_version: "1.0" });
    await enrichEventIntentIfMissing(event, "proj-1");
    expect(ghCalls).toHaveLength(0);
    expect(event.expected).toBeUndefined();
  });

  it("skips when contracts already exist", async () => {
    const event = v2Event({
      expected: { contracts: [{ source: "ts", path: "x", shape: { type: "object" } }] },
    });
    await enrichEventIntentIfMissing(event, "proj-1");
    expect(ghCalls).toHaveLength(0);
  });

  it("skips when commit SHA missing", async () => {
    const event = v2Event({ git: { repo: "octocat/myrepo" } });
    await enrichEventIntentIfMissing(event, "proj-1");
    expect(ghCalls).toHaveLength(0);
  });

  it("skips when repo cannot be resolved", async () => {
    const event = v2Event({ git: { commit: "deadbeefcafe1234" } });
    await enrichEventIntentIfMissing(event, "proj-1");
    expect(ghCalls).toHaveLength(0);
  });

  it("skips when no GitHub integration exists", async () => {
    dbIntegrations = []; // no rows
    ghContent = `interface Foo { a: string }`;
    const event = v2Event();
    await enrichEventIntentIfMissing(event, "proj-1");
    expect(ghCalls).toHaveLength(0);
    expect(event.expected).toBeUndefined();
  });

  it("does not throw on GitHub API error", async () => {
    ghThrow = true;
    const event = v2Event();
    await expect(enrichEventIntentIfMissing(event, "proj-1")).resolves.toBeUndefined();
    expect(event.expected).toBeUndefined();
  });

  it("falls back to parsing event.body when evidence.stack is absent", async () => {
    ghContent = `interface CreateUserRequest { email: string }`;
    const event = {
      schema_version: "2.0",
      git: { repo: "octocat/myrepo", commit: "abcdef1234567890" },
      body: "Error: boom\n    at CreateUserRequest (src/api/users.ts:42:5)",
    };
    await enrichEventIntentIfMissing(event as Record<string, unknown>, "proj-1");
    expect((event as { expected?: unknown }).expected).toBeDefined();
  });
});
