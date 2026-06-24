/**
 * /api/ai/dispatch — proxy route tests.
 *
 * Focused coverage for the v0.3 S7 tool-streaming addendum: the proxy
 * body now accepts a `tools` array, forwards it through `dispatchStream`,
 * and SSE-encodes `tool_call` deltas + `finish_reason` on the wire so
 * paired Rust clients can re-assemble function calls bit-identically.
 *
 * Pre-existing route behavior (auth, complete mode, error mapping) is
 * exercised indirectly via the dispatchStream mock — we deliberately do
 * not duplicate the unit tests in `packages/ai-router`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const dbMock = vi.hoisted(() => {
  type Chain = Promise<unknown[]> & {
    from: () => Chain;
    where: () => Chain;
  };
  function chain(rows: unknown[]): Chain {
    const c = Promise.resolve(rows) as Chain;
    c.from = () => chain(rows);
    c.where = () => chain(rows);
    return c;
  }
  return {
    select: vi.fn(() => chain([{ id: "p-1" }])),
  };
});

vi.mock("@/lib/db", () => ({
  db: dbMock,
  projects: { userId: "userId", id: "id" },
}));

const authMock = vi.hoisted(() => ({ authenticateExtensionToken: vi.fn() }));
vi.mock("@/lib/auth-extension", () => ({
  authenticateExtensionToken: authMock.authenticateExtensionToken,
}));

const keyMock = vi.hoisted(() => ({ getPlatformOpenAIKey: vi.fn() }));
vi.mock("@/lib/ai/get-key", () => ({
  getPlatformOpenAIKey: keyMock.getPlatformOpenAIKey,
}));

const togetherMock = vi.hoisted(() => ({ getTogetherOverride: vi.fn() }));
vi.mock("@/lib/ai/together-routing", () => ({
  getTogetherOverride: togetherMock.getTogetherOverride,
}));

const dispatchMock = vi.hoisted(() => {
  type Chunk = {
    delta: string;
    done: boolean;
    toolCall?: { index: number; id?: string; name?: string; argsDelta: string };
    finishReason?: string;
    receipt?: { model: string; inputTokens: number; outputTokens: number; cachedInputTokens: number };
  };
  let chunks: Chunk[] = [];
  let observedInput: Record<string, unknown> | null = null;
  return {
    setChunks(c: Chunk[]) {
      chunks = c;
    },
    observedInput: () => observedInput,
    reset() {
      chunks = [];
      observedInput = null;
    },
    dispatch: vi.fn(),
    dispatchStream: vi.fn(async function* (input: Record<string, unknown>) {
      observedInput = input;
      for (const c of chunks) yield c;
    }),
  };
});

vi.mock("@inariwatch/ai-router", () => ({
  dispatch: dispatchMock.dispatch,
  dispatchStream: dispatchMock.dispatchStream,
  ALL_TASKS: ["chat.conversational", "chat.code"],
}));

import { POST } from "../route";

function makeReq(body: unknown) {
  return new NextRequest(new URL("https://x/api/ai/dispatch"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: JSON.stringify(body),
  });
}

async function readSse(res: Response): Promise<string[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6));
}

beforeEach(() => {
  vi.clearAllMocks();
  dispatchMock.reset();
  authMock.authenticateExtensionToken.mockResolvedValue({ userId: "u-1", projectIds: [] });
  keyMock.getPlatformOpenAIKey.mockReturnValue({ key: "sk-platform", source: "platform" });
  // Default: no platform-funded Together override (BYOK / non-routed task path).
  togetherMock.getTogetherOverride.mockReturnValue(null);
});

describe("POST /api/ai/dispatch — tool streaming (S6.5)", () => {
  it("rejects malformed tools entries with 400", async () => {
    const res = await POST(
      makeReq({
        task: "chat.conversational",
        mode: "stream",
        system_prompt: "s",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 256,
        tools: [{ name: "" /* missing */, description: "x", input_schema: {} }],
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/tool\.name/);
  });

  it("caps tools at 100 entries", async () => {
    const tools = Array.from({ length: 101 }).map((_, i) => ({
      name: `t.${i}`,
      description: "x",
      input_schema: {},
    }));
    const res = await POST(
      makeReq({
        task: "chat.conversational",
        mode: "stream",
        system_prompt: "s",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 256,
        tools,
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/100/);
  });

  it("forwards tools to dispatchStream and SSE-encodes tool_call + finish_reason", async () => {
    dispatchMock.setChunks([
      {
        delta: "",
        done: false,
        toolCall: { index: 0, id: "call_x", name: "cloud.list_projects", argsDelta: "" },
      },
      { delta: "", done: false, toolCall: { index: 0, argsDelta: '{"a":1}' } },
      {
        delta: "",
        done: true,
        finishReason: "tool_calls",
        receipt: {
          model: "Qwen/Qwen3.5-9B-FP8",
          inputTokens: 7,
          outputTokens: 4,
          cachedInputTokens: 0,
        },
      },
    ]);

    const res = await POST(
      makeReq({
        task: "chat.conversational",
        mode: "stream",
        system_prompt: "s",
        messages: [{ role: "user", content: "list projects" }],
        max_tokens: 512,
        tools: [
          {
            name: "cloud.list_projects",
            description: "List projects.",
            input_schema: { type: "object" },
          },
        ],
      }),
    );

    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    // dispatchStream saw the tools array.
    const observed = dispatchMock.observedInput();
    expect(observed).not.toBeNull();
    expect((observed as { tools: unknown[] }).tools).toHaveLength(1);
    expect((observed as { tools: Array<{ name: string }> }).tools[0].name).toBe(
      "cloud.list_projects",
    );

    // Wire-level: 2 tool_call frames + 1 terminal frame with finish_reason.
    const frames = (await readSse(res)).map((p) => JSON.parse(p));
    expect(frames).toHaveLength(3);
    expect(frames[0]).toMatchObject({
      delta: "",
      done: false,
      tool_call: {
        index: 0,
        id: "call_x",
        name: "cloud.list_projects",
        arguments_delta: "",
      },
    });
    expect(frames[1]).toMatchObject({
      delta: "",
      done: false,
      tool_call: {
        index: 0,
        arguments_delta: '{"a":1}',
      },
    });
    // id/name omitted on continuation frames.
    expect(frames[1].tool_call.id).toBeUndefined();
    expect(frames[1].tool_call.name).toBeUndefined();
    expect(frames[2]).toMatchObject({
      delta: "",
      done: true,
      finish_reason: "tool_calls",
      model: "Qwen/Qwen3.5-9B-FP8",
      usage: { input_tokens: 7, output_tokens: 4, cached_input_tokens: 0 },
    });
  });

  it("defaults finish_reason to 'stop' for text-only streams (back-compat)", async () => {
    dispatchMock.setChunks([
      { delta: "hello", done: false },
      {
        delta: "",
        done: true,
        receipt: { model: "gpt-4o-mini", inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
      },
    ]);
    const res = await POST(
      makeReq({
        task: "chat.conversational",
        mode: "stream",
        system_prompt: "s",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 256,
      }),
    );
    const frames = (await readSse(res)).map((p) => JSON.parse(p));
    expect(frames[0]).toMatchObject({ delta: "hello", done: false });
    expect(frames[1]).toMatchObject({ done: true, finish_reason: "stop" });
  });
});

describe("POST /api/ai/dispatch — platform-funded routing override", () => {
  it("uses ALL THREE override values atomically (key + provider + model) when override fires", async () => {
    // Regression for the live 401 cascade where parsed.provider="openai"
    // (hardcoded by desktop's openai.rs:247) won precedence over the
    // override and routed Together's key to OpenAI's endpoint.
    togetherMock.getTogetherOverride.mockReturnValue({
      key: "tgp_v1_test",
      provider: "together",
      model: "moonshotai/Kimi-K2.6",
    });
    dispatchMock.setChunks([{ delta: "", done: true }]);

    const res = await POST(
      makeReq({
        task: "chat.conversational",
        mode: "stream",
        system_prompt: "s",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 256,
        // Caller hardcodes provider=openai (mirrors live desktop behavior).
        provider: "openai",
      }),
    );
    expect(res.status).toBe(200);

    const observed = dispatchMock.observedInput()!;
    expect(observed.apiKey).toBe("tgp_v1_test");
    expect(observed.provider).toBe("together");
    expect(observed.model).toBe("moonshotai/Kimi-K2.6");
  });

  it("override model wins over caller's parsed.model", async () => {
    togetherMock.getTogetherOverride.mockReturnValue({
      key: "tgp_v1_test",
      provider: "together",
      model: "moonshotai/Kimi-K2.6",
    });
    dispatchMock.setChunks([{ delta: "", done: true }]);

    const res = await POST(
      makeReq({
        task: "chat.conversational",
        mode: "stream",
        system_prompt: "s",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 256,
        // Caller suggests a stale model (e.g. an old client).
        model: "gpt-4o-mini",
      }),
    );
    expect(res.status).toBe(200);
    expect(dispatchMock.observedInput()!.model).toBe("moonshotai/Kimi-K2.6");
  });

  it("falls through to caller hints when no override fires (non-routed task / BYOK)", async () => {
    togetherMock.getTogetherOverride.mockReturnValue(null);
    dispatchMock.setChunks([{ delta: "", done: true }]);

    const res = await POST(
      makeReq({
        task: "chat.conversational",
        mode: "stream",
        system_prompt: "s",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 256,
        provider: "openai",
        model: "gpt-4o-mini",
      }),
    );
    expect(res.status).toBe(200);

    const observed = dispatchMock.observedInput()!;
    expect(observed.apiKey).toBe("sk-platform");   // BYOK / platform OpenAI fallback
    expect(observed.provider).toBe("openai");      // caller hint preserved
    expect(observed.model).toBe("gpt-4o-mini");    // caller hint preserved
  });

  it("accepts provider: 'together' from explicit Rust callers without 400ing", async () => {
    // Regression for ALLOWED_PROVIDERS missing "together" — future Rust
    // clients that drop the openai.rs hardcode and pass the rule's
    // routing intent verbatim should not be rejected at validateBody.
    togetherMock.getTogetherOverride.mockReturnValue(null);
    dispatchMock.setChunks([{ delta: "", done: true }]);

    const res = await POST(
      makeReq({
        task: "chat.conversational",
        mode: "stream",
        system_prompt: "s",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 256,
        provider: "together",
      }),
    );
    expect(res.status).toBe(200);
    expect(dispatchMock.observedInput()!.provider).toBe("together");
  });
});
