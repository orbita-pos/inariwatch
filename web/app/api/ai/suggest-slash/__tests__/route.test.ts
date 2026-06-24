/**
 * /api/ai/suggest-slash — Phase 2 autocomplete route tests.
 *
 * Covers the four wire contracts called out in the brief:
 *   1. Happy path — model returns 3 well-formed suggestions
 *   2. Empty array when the LLM signals off-topic / no match
 *   3. 401 when the Bearer token is invalid
 *   4. 400 on malformed bodies (missing query, missing manifest, too long)
 *
 * Plus a few defensive cases:
 *   - LLM returns invalid JSON → empty suggestions (route never throws)
 *   - LLM hallucinates a command not in the manifest → filtered out
 *   - Suggestions cap at 3 even when the model returns more
 *   - parseAndValidateOutput sanity-checks confidence + rationale
 *
 * Patterns mirror `web/app/api/ai/dispatch/__tests__/route.test.ts`:
 * hoisted vi.mocks for db/auth/redis/etc.; the route is imported AFTER
 * the mocks are registered so the inline imports resolve to the doubles.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks (vi.hoisted so they apply before the route's static imports) ──
//
// `@/lib/db` is mocked first because several mocked modules below
// transitively import the real db at module-init time. Without this
// short-circuit, vitest tries to instantiate the real Neon client and
// throws "DATABASE_URL is not set". Same pattern as the dispatch
// route test.

vi.mock("@/lib/db", () => ({
  db:           {},
  projects:     {},
  apiKeys:      {},
  deviceTokens: {},
  users:        {},
}));

const authMock = vi.hoisted(() => ({
  authenticateExtensionToken: vi.fn(),
}));
vi.mock("@/lib/auth-extension", () => ({
  authenticateExtensionToken: authMock.authenticateExtensionToken,
}));

const rateLimitMock = vi.hoisted(() => ({ rateLimit: vi.fn() }));
vi.mock("@/lib/auth-rate-limit", () => ({
  rateLimit: rateLimitMock.rateLimit,
}));

const redisMock = vi.hoisted(() => ({ getRedis: vi.fn() }));
vi.mock("@/lib/redis", () => ({
  getRedis: redisMock.getRedis,
}));

const keyMock = vi.hoisted(() => ({
  getPlatformTogetherKey: vi.fn(),
  getPlatformOpenAIKey:   vi.fn(),
}));
vi.mock("@/lib/ai/get-key", () => ({
  getPlatformTogetherKey: keyMock.getPlatformTogetherKey,
  getPlatformOpenAIKey:   keyMock.getPlatformOpenAIKey,
}));

const togetherMock = vi.hoisted(() => ({ getTogetherOverride: vi.fn() }));
vi.mock("@/lib/ai/together-routing", () => ({
  getTogetherOverride: togetherMock.getTogetherOverride,
}));

const aiMock = vi.hoisted(() => ({ callAI: vi.fn() }));
vi.mock("@/lib/ai/client", () => ({
  callAI: aiMock.callAI,
}));

// Route imported AFTER mocks so its static imports resolve correctly.
// Pure helpers live in a sibling file (Next.js route-files reject
// arbitrary named exports), tests drive them from there.
import { POST } from "../route";
import { parseAndValidateOutput, validateBody } from "../helpers";

// ── Helpers ───────────────────────────────────────────────────────────────

function makeReq(body: unknown, hasAuth = true): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (hasAuth) headers.authorization = "Bearer test-token";
  return new NextRequest("http://localhost/api/ai/suggest-slash", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function manifestFixture() {
  return [
    {
      name: "/projects",
      description: "List projects in your workspace with active integrations.",
      args: [
        {
          name: "integration",
          type: "enum" as const,
          required: false,
          description: "Filter to projects where this integration is active.",
          enumValues: ["capture", "github", "vercel"],
          flag: "integration",
        },
      ],
    },
    {
      name: "/alerts",
      description: "Recent alerts across the workspace.",
      args: [
        {
          name: "limit",
          type: "number" as const,
          required: false,
          description: "How many alerts to fetch.",
        },
      ],
    },
    {
      name: "/install",
      description: "Install @inariwatch/capture into a local repo.",
      args: [
        {
          name: "path",
          type: "path" as const,
          required: true,
          description: "Absolute path to the local repo.",
        },
      ],
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: authenticated user, rate limit allowed, no Redis cache,
  // platform Together key available, override active (Qwen3.5-9B).
  authMock.authenticateExtensionToken.mockResolvedValue({
    userId: "u-1",
    projectIds: ["p-1"],
  });
  rateLimitMock.rateLimit.mockResolvedValue({ allowed: true });
  redisMock.getRedis.mockReturnValue(null);
  keyMock.getPlatformTogetherKey.mockReturnValue({
    key: "tgp_test",
    provider: "together",
    modelPrefs: null,
    isPlatformKey: true,
  });
  keyMock.getPlatformOpenAIKey.mockReturnValue(null);
  togetherMock.getTogetherOverride.mockReturnValue({
    key: "tgp_test",
    provider: "together",
    model: "Qwen/Qwen3.5-9B-FP8",
  });
});

// ── Tests ────────────────────────────────────────────────────────────────

describe("POST /api/ai/suggest-slash", () => {
  it("returns the model's suggestions on the happy path", async () => {
    aiMock.callAI.mockResolvedValueOnce(
      JSON.stringify({
        suggestions: [
          {
            command: "/projects --integration=capture",
            rationale: "matches 'projects with capture'",
            confidence: 0.92,
          },
          {
            command: "/alerts 50",
            rationale: "could be asking about alerts",
            confidence: 0.18,
          },
        ],
      }),
    );

    const res = await POST(
      makeReq({
        query: "que proyectos tienen capture",
        manifest: manifestFixture(),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestions).toHaveLength(2);
    expect(body.suggestions[0]).toMatchObject({
      command: "/projects --integration=capture",
      confidence: 0.92,
    });
  });

  it("returns an empty array when the LLM signals off-topic", async () => {
    aiMock.callAI.mockResolvedValueOnce(
      JSON.stringify({ suggestions: [] }),
    );

    const res = await POST(
      makeReq({
        query: "explain CSS box-sizing",
        manifest: manifestFixture(),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestions).toEqual([]);
  });

  it("returns 401 when authentication fails", async () => {
    authMock.authenticateExtensionToken.mockResolvedValueOnce(null);
    const res = await POST(
      makeReq({ query: "anything", manifest: manifestFixture() }, false),
    );
    expect(res.status).toBe(401);
    expect(aiMock.callAI).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After when rate-limited", async () => {
    rateLimitMock.rateLimit.mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 45,
    });
    const res = await POST(
      makeReq({ query: "anything", manifest: manifestFixture() }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("45");
  });

  it("returns 400 when the query field is missing", async () => {
    const res = await POST(makeReq({ manifest: manifestFixture() }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/query/i);
  });

  it("returns 400 when the manifest is missing", async () => {
    const res = await POST(makeReq({ query: "hello" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/manifest/i);
  });

  it("returns 400 when the query is too long", async () => {
    const tooLong = "a".repeat(2_000);
    const res = await POST(
      makeReq({ query: tooLong, manifest: manifestFixture() }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when manifest entries have wrong shape", async () => {
    const res = await POST(
      makeReq({
        query: "x",
        // missing args[]
        manifest: [{ name: "/projects", description: "ok" }],
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns empty suggestions when no platform key is configured", async () => {
    keyMock.getPlatformTogetherKey.mockReturnValueOnce(null);
    keyMock.getPlatformOpenAIKey.mockReturnValueOnce(null);
    const res = await POST(
      makeReq({ query: "anything", manifest: manifestFixture() }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestions).toEqual([]);
    expect(aiMock.callAI).not.toHaveBeenCalled();
  });

  it("returns empty suggestions when the LLM call throws (offline / 5xx)", async () => {
    aiMock.callAI.mockRejectedValueOnce(new Error("provider 503"));
    const res = await POST(
      makeReq({ query: "anything", manifest: manifestFixture() }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestions).toEqual([]);
  });

  it("filters hallucinated commands not in the manifest", async () => {
    aiMock.callAI.mockResolvedValueOnce(
      JSON.stringify({
        suggestions: [
          { command: "/projects", rationale: "ok", confidence: 0.8 },
          // Not in fixture's manifest — must be dropped.
          { command: "/unknown", rationale: "no", confidence: 0.7 },
        ],
      }),
    );
    const res = await POST(
      makeReq({ query: "show projects", manifest: manifestFixture() }),
    );
    const body = await res.json();
    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0].command).toBe("/projects");
  });

  it("passes the Together override key + model to callAI when platform-funded", async () => {
    aiMock.callAI.mockResolvedValueOnce(
      JSON.stringify({ suggestions: [] }),
    );
    await POST(
      makeReq({ query: "anything", manifest: manifestFixture() }),
    );
    expect(aiMock.callAI).toHaveBeenCalledTimes(1);
    const [apiKey, _systemPrompt, _msgs, opts] = aiMock.callAI.mock.calls[0]!;
    expect(apiKey).toBe("tgp_test");
    expect(opts).toMatchObject({
      provider: "together",
      model: "Qwen/Qwen3.5-9B-FP8",
      jsonMode: true,
      temperature: 0,
    });
  });
});

// ── parseAndValidateOutput pure-function tests ───────────────────────────

describe("parseAndValidateOutput", () => {
  const names = new Set(["/projects", "/alerts", "/install"]);

  it("returns [] for invalid JSON", () => {
    expect(parseAndValidateOutput("not json", names)).toEqual([]);
  });

  it("returns [] when suggestions is not an array", () => {
    expect(parseAndValidateOutput("{}", names)).toEqual([]);
    expect(parseAndValidateOutput('{"suggestions":"oops"}', names)).toEqual([]);
  });

  it("drops items with non-numeric confidence", () => {
    const out = parseAndValidateOutput(
      JSON.stringify({
        suggestions: [
          { command: "/projects", rationale: "ok", confidence: "high" },
          { command: "/alerts", rationale: "ok", confidence: 0.5 },
        ],
      }),
      names,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.command).toBe("/alerts");
  });

  it("clamps confidence to [0, 1]", () => {
    const out = parseAndValidateOutput(
      JSON.stringify({
        suggestions: [
          { command: "/projects", rationale: "ok", confidence: 2.5 },
          { command: "/alerts", rationale: "ok", confidence: -0.3 },
        ],
      }),
      names,
    );
    expect(out[0]!.confidence).toBe(1);
    expect(out[1]!.confidence).toBe(0);
  });

  it("caps the suggestion list at MAX_SUGGESTIONS (3)", () => {
    const all = [...Array(6)].map((_, i) => ({
      command: "/projects",
      rationale: `r${i}`,
      confidence: 0.5,
    }));
    const out = parseAndValidateOutput(
      JSON.stringify({ suggestions: all }),
      names,
    );
    expect(out).toHaveLength(3);
  });

  it("drops commands not in the manifest", () => {
    const out = parseAndValidateOutput(
      JSON.stringify({
        suggestions: [
          { command: "/unknown", rationale: "x", confidence: 0.9 },
          { command: "/projects", rationale: "y", confidence: 0.7 },
        ],
      }),
      names,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.command).toBe("/projects");
  });

  it("trims and caps rationale length", () => {
    const longRationale = " " + "x".repeat(500) + " ";
    const out = parseAndValidateOutput(
      JSON.stringify({
        suggestions: [
          { command: "/projects", rationale: longRationale, confidence: 0.5 },
        ],
      }),
      names,
    );
    expect(out[0]!.rationale.length).toBeLessThanOrEqual(200);
    // Trimmed — should not start with whitespace.
    expect(out[0]!.rationale.startsWith(" ")).toBe(false);
  });

  it("matches commands with embedded args (everything before first space)", () => {
    const out = parseAndValidateOutput(
      JSON.stringify({
        suggestions: [
          {
            command: "/projects --integration=capture",
            rationale: "good",
            confidence: 0.9,
          },
        ],
      }),
      names,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.command).toBe("/projects --integration=capture");
  });
});

// ── validateBody pure-function tests ─────────────────────────────────────

describe("validateBody", () => {
  it("accepts a well-formed body", () => {
    const body = { query: "hello", manifest: manifestFixture() };
    const result = validateBody(body);
    expect(typeof result).not.toBe("string");
  });

  it("rejects whitespace-only query", () => {
    const result = validateBody({ query: "   ", manifest: manifestFixture() });
    expect(typeof result).toBe("string");
  });

  it("rejects manifest with non-slash names", () => {
    const result = validateBody({
      query: "x",
      manifest: [{ name: "no-slash", description: "x", args: [] }],
    });
    expect(typeof result).toBe("string");
  });

  it("rejects empty manifest", () => {
    const result = validateBody({ query: "x", manifest: [] });
    expect(typeof result).toBe("string");
  });

  // ── Phase 5.4 — memoryContext validation ────────────────────────────────

  it("accepts an optional memoryContext string", () => {
    const result = validateBody({
      query: "fixea esa alerta",
      manifest: manifestFixture(),
      memoryContext: "Recent context (most recent last):\n- /alerts (just now) — 2 critical",
    });
    expect(typeof result).toBe("object");
    if (typeof result === "string") return;
    expect(result.memoryContext).toContain("Recent context");
  });

  it("collapses empty memoryContext to undefined", () => {
    for (const value of ["", "   ", "\n\n"]) {
      const result = validateBody({
        query: "x",
        manifest: manifestFixture(),
        memoryContext: value,
      });
      if (typeof result === "string") throw new Error(result);
      expect(result.memoryContext).toBeUndefined();
    }
  });

  it("rejects memoryContext beyond MAX_MEMORY_CONTEXT_BYTES", async () => {
    const { MAX_MEMORY_CONTEXT_BYTES } = await import("../helpers");
    const huge = "a".repeat(MAX_MEMORY_CONTEXT_BYTES + 1);
    const result = validateBody({
      query: "x",
      manifest: manifestFixture(),
      memoryContext: huge,
    });
    expect(typeof result).toBe("string");
    if (typeof result !== "string") return;
    expect(result).toContain("memoryContext is");
    expect(result).toContain("max");
  });

  it("rejects non-string memoryContext", () => {
    const result = validateBody({
      query: "x",
      manifest: manifestFixture(),
      // @ts-expect-error -- runtime invalid input
      memoryContext: { not: "a string" },
    });
    expect(typeof result).toBe("string");
  });
});

// ── Phase 5.4 — buildUserPrompt placement contract ───────────────────────

describe("buildUserPrompt placement (Phase 5.4 — Lost-in-the-Middle)", () => {
  it("places memoryContext between the cacheable prefix and the query", async () => {
    const { buildUserPrompt, buildCacheableUserPromptPrefix } = await import(
      "../helpers"
    );
    const manifest = '[{"name":"/x","description":"","args":[]}]';
    const memory = "Recent context: alert_abc (payment 12:01)";
    const query = "fixea la del payment";
    const prompt = buildUserPrompt(manifest, query, memory);

    const prefix = buildCacheableUserPromptPrefix(manifest);
    const prefixIdx = prompt.indexOf(prefix);
    const memoryIdx = prompt.indexOf(memory);
    const queryIdx  = prompt.indexOf(`User query:\n${query}`);

    expect(prefixIdx).toBe(0);
    expect(memoryIdx).toBeGreaterThan(prefixIdx);
    expect(queryIdx).toBeGreaterThan(memoryIdx);
  });

  it("omits the memory block entirely when memoryContext is empty / undefined", async () => {
    const { buildUserPrompt } = await import("../helpers");
    const manifest = '[{"name":"/x","description":"","args":[]}]';
    const noMemory = buildUserPrompt(manifest, "q");
    const emptyMemory = buildUserPrompt(manifest, "q", "");
    expect(noMemory).toBe(emptyMemory);
    expect(noMemory).not.toContain("Recent context");
  });

  it("byte-identical cacheable prefix across different memoryContext values", async () => {
    // Cacheability invariant — research mini-diff 3 (Phase 5.9
    // anchors this in the corpus too; smoke it here so any future
    // edit to `buildUserPrompt` that accidentally splices memory
    // into the cacheable prefix fails fast.
    const { buildUserPrompt, buildCacheableUserPromptPrefix } = await import(
      "../helpers"
    );
    const manifest = '[{"name":"/x","description":"","args":[]}]';

    const prefixOnce = buildCacheableUserPromptPrefix(manifest);
    const promptA = buildUserPrompt(manifest, "q1", "memA");
    const promptB = buildUserPrompt(manifest, "q2", "memB");

    expect(promptA.startsWith(prefixOnce)).toBe(true);
    expect(promptB.startsWith(prefixOnce)).toBe(true);
    expect(promptA.slice(0, prefixOnce.length)).toBe(
      promptB.slice(0, prefixOnce.length),
    );
  });
});

// ── Phase 5.4 — cache key keys on memoryContext ──────────────────────────

describe("POST /api/ai/suggest-slash — memoryContext threading", () => {
  it("forwards memoryContext into the user prompt verbatim", async () => {
    aiMock.callAI.mockResolvedValueOnce(
      JSON.stringify({
        suggestions: [
          { command: "/alerts", rationale: "match", confidence: 0.9 },
        ],
      }),
    );
    const memory = "Recent context: alert_abc (payment timeout 12:01)";
    const req = makeReq({
      query: "fixea la del payment",
      manifest: manifestFixture(),
      memoryContext: memory,
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    expect(aiMock.callAI).toHaveBeenCalledTimes(1);
    const callArgs = aiMock.callAI.mock.calls[0];
    const messages = callArgs[2];
    const userMessage = messages[0].content;
    // Memory appears between the manifest and the user-query marker.
    const manifestIdx = userMessage.indexOf("Available slash commands");
    const memoryIdx = userMessage.indexOf(memory);
    const queryIdx = userMessage.indexOf("User query:");
    expect(manifestIdx).toBeGreaterThanOrEqual(0);
    expect(memoryIdx).toBeGreaterThan(manifestIdx);
    expect(queryIdx).toBeGreaterThan(memoryIdx);
  });

  it("two requests with same query/manifest but different memory produce different cache keys", async () => {
    // We don't have direct access to computeCacheKey from outside the
    // route (it's route-local). The observable proxy is: if the redis
    // mock receives DIFFERENT `cacheKey` values for two such requests,
    // the keying honors memoryContext.
    const captured: string[] = [];
    redisMock.getRedis.mockReturnValue({
      get: vi.fn(async (key: string) => {
        captured.push(key);
        return null;
      }),
      set: vi.fn(async () => undefined),
    });
    aiMock.callAI.mockResolvedValue(
      JSON.stringify({ suggestions: [] }),
    );
    await POST(
      makeReq({
        query: "fixea la del payment",
        manifest: manifestFixture(),
        memoryContext: "alert_abc payment 12:01",
      }),
    );
    await POST(
      makeReq({
        query: "fixea la del payment",
        manifest: manifestFixture(),
        memoryContext: "alert_xyz DB pool 11:58",
      }),
    );
    expect(captured).toHaveLength(2);
    expect(captured[0]).not.toBe(captured[1]);
  });
});
