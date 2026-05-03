/**
 * Phase 1.6 — Code Intelligence v2 worker tools.
 *
 * Tests gating, schema, and HTTP wiring without spinning up a real web app.
 */

// node:test is the canonical worker test runner (`npm test` script in
// worker/package.json runs `tsx --test`). vitest is the runner we use in
// this disk-tight worktree because tsx isn't installed. The two share
// describe/it/before/after vocab — but assertions differ. We use a thin
// shim so the same source compiles under both.
import {
  describe,
  it,
  afterAll as after,
  beforeAll as before,
  beforeEach,
  expect,
} from "vitest";

const assert = {
  equal: <T>(a: T, b: T, msg?: string) => expect(a, msg).toBe(b),
  match: (actual: string, re: RegExp, msg?: string) => expect(actual, msg).toMatch(re),
  ok: (cond: unknown, msg?: string) => expect(cond, msg).toBeTruthy(),
  deepEqual: <T>(a: T, b: T, msg?: string) => expect(a, msg).toEqual(b),
};

import {
  CODE_INTEL_V2_TOOLS,
  appendCodeIntelV2Tools,
  executeCodeIntelTool,
  isCodeIntelV2ToolsEnabled,
} from "../tools/code-intel.js";

const ENV_BACKUP = process.env.CODE_INTEL_V2_TOOLS;

after(() => {
  if (ENV_BACKUP === undefined) delete process.env.CODE_INTEL_V2_TOOLS;
  else process.env.CODE_INTEL_V2_TOOLS = ENV_BACKUP;
});

beforeEach(() => {
  delete process.env.CODE_INTEL_V2_TOOLS;
});

describe("CODE_INTEL_V2_TOOLS schema", () => {
  it("ships exactly 3 tools (find_references, type_at, blast_radius)", () => {
    assert.equal(CODE_INTEL_V2_TOOLS.length, 3);
    assert.deepEqual(
      CODE_INTEL_V2_TOOLS.map((t) => t.name).sort(),
      ["blast_radius", "find_references", "type_at"],
    );
  });

  it("each tool declares its required input schema", () => {
    for (const tool of CODE_INTEL_V2_TOOLS) {
      assert.ok(tool.input_schema && tool.input_schema.type === "object");
      const schema = tool.input_schema as { required?: string[] };
      assert.ok(Array.isArray(schema.required) && schema.required.length > 0);
    }
  });
});

describe("isCodeIntelV2ToolsEnabled", () => {
  it("default off", () => {
    delete process.env.CODE_INTEL_V2_TOOLS;
    assert.equal(isCodeIntelV2ToolsEnabled(), false);
  });

  it("on when env var = 'on' (case-insensitive, trimmed)", () => {
    process.env.CODE_INTEL_V2_TOOLS = "on";
    assert.equal(isCodeIntelV2ToolsEnabled(), true);
    process.env.CODE_INTEL_V2_TOOLS = "  ON  ";
    assert.equal(isCodeIntelV2ToolsEnabled(), true);
  });

  it("anything else is off (typo protection)", () => {
    process.env.CODE_INTEL_V2_TOOLS = "true";
    assert.equal(isCodeIntelV2ToolsEnabled(), false);
    process.env.CODE_INTEL_V2_TOOLS = "yes";
    assert.equal(isCodeIntelV2ToolsEnabled(), false);
  });
});

describe("appendCodeIntelV2Tools", () => {
  it("returns base unchanged when flag is off", () => {
    delete process.env.CODE_INTEL_V2_TOOLS;
    const base = [{ name: "x", description: "", input_schema: { type: "object" as const } }];
    const out = appendCodeIntelV2Tools(base);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.name, "x");
  });

  it("appends 3 tools when flag is on", () => {
    process.env.CODE_INTEL_V2_TOOLS = "on";
    const base = [{ name: "x", description: "", input_schema: { type: "object" as const } }];
    const out = appendCodeIntelV2Tools(base);
    assert.equal(out.length, 4);
    const names = out.map((t) => t.name);
    assert.ok(names.includes("find_references"));
    assert.ok(names.includes("type_at"));
    assert.ok(names.includes("blast_radius"));
  });
});

describe("executeCodeIntelTool — gating + arg validation", () => {
  it("flag off → returns the explicit error string", async () => {
    delete process.env.CODE_INTEL_V2_TOOLS;
    const out = await executeCodeIntelTool(
      "find_references",
      { symbol_fqn: "src/a.ts::foo" },
      { webUrl: "http://x", cronSecret: "s", projectId: "p1" },
    );
    assert.match(out, /not enabled/);
  });

  it("missing CRON_SECRET → returns explicit error", async () => {
    process.env.CODE_INTEL_V2_TOOLS = "on";
    const out = await executeCodeIntelTool(
      "find_references",
      { symbol_fqn: "src/a.ts::foo" },
      { webUrl: "http://x", cronSecret: "", projectId: "p1" },
    );
    assert.match(out, /CRON_SECRET not set/);
  });

  it("missing projectId AND repoId → returns explicit error", async () => {
    process.env.CODE_INTEL_V2_TOOLS = "on";
    const out = await executeCodeIntelTool(
      "find_references",
      { symbol_fqn: "src/a.ts::foo" },
      { webUrl: "http://x", cronSecret: "s", projectId: null, repoId: null },
    );
    assert.match(out, /neither projectId nor repoId/);
  });

  it("find_references requires symbol_fqn", async () => {
    process.env.CODE_INTEL_V2_TOOLS = "on";
    const out = await executeCodeIntelTool(
      "find_references",
      {},
      { webUrl: "http://x", cronSecret: "s", projectId: "p1" },
    );
    assert.match(out, /symbol_fqn is required/);
  });

  it("type_at requires file_path + line", async () => {
    process.env.CODE_INTEL_V2_TOOLS = "on";
    const out1 = await executeCodeIntelTool(
      "type_at",
      { line: 1 },
      { webUrl: "http://x", cronSecret: "s", projectId: "p1" },
    );
    assert.match(out1, /file_path is required/);
    const out2 = await executeCodeIntelTool(
      "type_at",
      { file_path: "src/a.ts" },
      { webUrl: "http://x", cronSecret: "s", projectId: "p1" },
    );
    assert.match(out2, /line is required/);
  });
});

describe("executeCodeIntelTool — HTTP wiring", () => {
  let originalFetch: typeof globalThis.fetch;
  let lastCall: { url: string; init: RequestInit | undefined } | null;

  before(() => {
    originalFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    lastCall = null;
    process.env.CODE_INTEL_V2_TOOLS = "on";
    globalThis.fetch = (async (url, init) => {
      lastCall = { url: String(url), init };
      return new Response(JSON.stringify({ ok: true, target: String(url) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
  });

  it("find_references hits /api/code-intel-v2/find-references with proper body", async () => {
    const text = await executeCodeIntelTool(
      "find_references",
      { symbol_fqn: "src/a.ts::foo", kind: "function" },
      { webUrl: "https://app.test", cronSecret: "secret", projectId: "p1" },
    );
    assert.match(text, /find-references/);
    assert.equal(lastCall?.url, "https://app.test/api/code-intel-v2/find-references");
    const body = JSON.parse(String(lastCall?.init?.body));
    assert.equal(body.symbolFqn, "src/a.ts::foo");
    assert.equal(body.kind, "function");
    assert.equal(body.projectId, "p1");
    const headers = (lastCall?.init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer secret");
  });

  it("type_at hits /type-at and forwards filePath + line + col", async () => {
    await executeCodeIntelTool(
      "type_at",
      { file_path: "src/a.ts", line: 10, col: 5 },
      { webUrl: "https://app.test", cronSecret: "secret", projectId: "p1" },
    );
    assert.equal(lastCall?.url, "https://app.test/api/code-intel-v2/type-at");
    const body = JSON.parse(String(lastCall?.init?.body));
    assert.equal(body.filePath, "src/a.ts");
    assert.equal(body.line, 10);
    assert.equal(body.col, 5);
  });

  it("blast_radius hits /blast-radius and forwards depth", async () => {
    await executeCodeIntelTool(
      "blast_radius",
      { symbol_fqn: "src/a.ts::foo", depth: 3 },
      { webUrl: "https://app.test", cronSecret: "secret", projectId: "p1" },
    );
    assert.equal(lastCall?.url, "https://app.test/api/code-intel-v2/blast-radius");
    const body = JSON.parse(String(lastCall?.init?.body));
    assert.equal(body.depth, 3);
  });

  it("non-2xx response is surfaced as Error: …", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500, statusText: "Internal Server Error" })) as typeof globalThis.fetch;
    const out = await executeCodeIntelTool(
      "find_references",
      { symbol_fqn: "x" },
      { webUrl: "http://x", cronSecret: "s", projectId: "p1" },
    );
    assert.match(out, /Error: .* 500/);
  });
});
