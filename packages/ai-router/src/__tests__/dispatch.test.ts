import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatch,
  callAI,
  callAIWithTools,
  detectProvider,
} from "../dispatch";
import { TASKS } from "../tasks";
import {
  clearReceiptSinks,
  receiptSinkCount,
  registerReceiptSink,
  type RouterReceipt,
} from "../receipts";

// ── Fetch stubbing helper ──────────────────────────────────────────────────
//
// dispatch() ultimately calls fetch() inside the provider adapters. Stubbing
// global.fetch lets us assert routing decisions + receipt fields without any
// real network access.

interface StubResponse {
  status?: number;
  body: unknown;
  /** Counter — incremented on each call. */
  hits?: number;
}

function makeFetchStub(
  routes: Record<string, StubResponse>,
): { spy: ReturnType<typeof vi.fn>; routes: Record<string, StubResponse> } {
  const spy = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    for (const pattern of Object.keys(routes)) {
      if (url.includes(pattern)) {
        const r = routes[pattern];
        r.hits = (r.hits ?? 0) + 1;
        const status = r.status ?? 200;
        const body =
          typeof r.body === "string" ? r.body : JSON.stringify(r.body);
        return new Response(body, {
          status,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    throw new Error(`unstubbed fetch: ${url}`);
  });
  return { spy: spy as ReturnType<typeof vi.fn>, routes };
}

describe("dispatch() — Phase 1 cloud routing", () => {
  let originalFetch: typeof globalThis.fetch;
  let receipts: RouterReceipt[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    receipts = [];
    clearReceiptSinks();
    registerReceiptSink((r) => {
      receipts.push(r);
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearReceiptSinks();
  });

  it("routes complete-mode through OpenAI when key looks like sk-", async () => {
    const { spy } = makeFetchStub({
      "api.openai.com": {
        body: {
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      },
    });
    globalThis.fetch = spy;

    const out = await dispatch({
      mode: "complete",
      task: TASKS.ALERT_AUTO_ANALYZE,
      apiKey: "sk-test",
      systemPrompt: "system",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(out.mode).toBe("complete");
    if (out.mode === "complete") {
      expect(out.response.text).toBe("ok");
      expect(out.response.provider).toBe("openai");
    }
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("routes complete-mode through Anthropic when key starts with sk-ant-", async () => {
    const { spy } = makeFetchStub({
      "api.anthropic.com": {
        body: {
          content: [{ text: "claude-ok", type: "text" }],
          usage: { input_tokens: 8, output_tokens: 4 },
        },
      },
    });
    globalThis.fetch = spy;

    const out = await dispatch({
      mode: "complete",
      task: TASKS.ALERT_AUTO_ANALYZE,
      apiKey: "sk-ant-test",
      systemPrompt: "system",
      messages: [{ role: "user", content: "hi" }],
    });

    if (out.mode === "complete") {
      expect(out.response.text).toBe("claude-ok");
      expect(out.response.provider).toBe("claude");
    }
  });

  it("respects explicit provider override regardless of key prefix", async () => {
    const { spy, routes } = makeFetchStub({
      "api.openai.com": {
        body: { choices: [{ message: { content: "openai" } }], usage: {} },
      },
      "api.anthropic.com": {
        body: {
          content: [{ text: "anthropic", type: "text" }],
          usage: {},
        },
      },
    });
    globalThis.fetch = spy;

    await dispatch({
      mode: "complete",
      task: TASKS.ALERT_AUTO_ANALYZE,
      apiKey: "sk-anything",
      provider: "claude",
      systemPrompt: "s",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(routes["api.anthropic.com"].hits).toBe(1);
    expect(routes["api.openai.com"].hits ?? 0).toBe(0);
  });

  it("emits a receipt with task / substrate / provider / timing", async () => {
    const { spy } = makeFetchStub({
      "api.openai.com": {
        body: {
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      },
    });
    globalThis.fetch = spy;

    await dispatch({
      mode: "complete",
      task: TASKS.NOTIFY_COMPOSE_EMAIL,
      apiKey: "sk-test",
      systemPrompt: "system",
      messages: [{ role: "user", content: "hi" }],
      workspace: {
        userId: "user-123",
        workspaceId: "ws-1",
        isPlatformKey: true,
      },
    });

    expect(receipts.length).toBe(1);
    const r = receipts[0];
    expect(r.task).toBe(TASKS.NOTIFY_COMPOSE_EMAIL);
    expect(r.namespace).toBe("notify");
    expect(r.substrate).toBe("cloud");
    expect(r.provider).toBe("openai");
    expect(r.userId).toBe("user-123");
    expect(r.workspaceId).toBe("ws-1");
    expect(r.isPlatformKey).toBe(true);
    expect(r.fallbackUsed).toBe(false);
    expect(r.tsEnd).toBeGreaterThanOrEqual(r.tsStart);
  });

  it("falls back to secondary provider on cloud-error trigger", async () => {
    const { spy, routes } = makeFetchStub({
      "api.openai.com": {
        status: 503,
        body: "service unavailable",
      },
      "api.anthropic.com": {
        body: {
          content: [{ text: "fallback-ok", type: "text" }],
          usage: {},
        },
      },
    });
    globalThis.fetch = spy;

    const out = await dispatch({
      mode: "complete",
      task: TASKS.CODE_FIX_SINGLE_SHOT,
      apiKey: "sk-test",
      systemPrompt: "system",
      messages: [{ role: "user", content: "hi" }],
    });

    if (out.mode === "complete") {
      expect(out.response.text).toBe("fallback-ok");
    }
    expect(routes["api.openai.com"].hits).toBe(1);
    expect(routes["api.anthropic.com"].hits).toBe(1);
    expect(receipts[0].fallbackUsed).toBe(true);
    expect(receipts[0].provider).toBe("claude");
  });

  it("does NOT fall back when error doesn't match a fallback trigger", async () => {
    const { spy } = makeFetchStub({
      "api.openai.com": {
        status: 401,
        body: "unauthorized",
      },
    });
    globalThis.fetch = spy;

    await expect(
      dispatch({
        mode: "complete",
        task: TASKS.ALERT_AUTO_ANALYZE,
        apiKey: "sk-test",
        systemPrompt: "system",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/401/);
    // No receipt emitted — dispatch threw before reaching emitReceipt.
    expect(receipts.length).toBe(0);
  });

  it("user-sidecar substrate falls back to cloud when stub throws", async () => {
    // Phase 1 user-sidecar always throws. Set up a rule that points at it
    // with a cloud fallback to cover the path Phase 2 will exercise.
    const { spy, routes } = makeFetchStub({
      "api.openai.com": {
        body: {
          choices: [{ message: { content: "fallback" } }],
          usage: {},
        },
      },
    });
    globalThis.fetch = spy;

    const out = await dispatch({
      mode: "complete",
      task: TASKS.NOTIFY_COMPOSE_EMAIL,
      apiKey: "sk-test",
      systemPrompt: "system",
      messages: [{ role: "user", content: "hi" }],
      workspace: {
        taskOverrides: {
          [TASKS.NOTIFY_COMPOSE_EMAIL]: {
            substrate: "user-sidecar",
            model: "llama-3.2-3b-q4",
          },
        },
      },
    });
    // Override doesn't define a fallback, but the rule's default fallback for
    // notify.compose.email isn't set today, so the dispatch must throw — the
    // sidecar stub error bubbles up.
    expect(out.mode).toBe("complete");
    if (out.mode === "complete") {
      expect(out.response.text).toBe("fallback");
    }
    expect(routes["api.openai.com"].hits).toBe(1);
  });
});

describe("callAI helper (parity with legacy client)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearReceiptSinks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearReceiptSinks();
  });

  it("returns text and respects opts.task", async () => {
    const { spy } = makeFetchStub({
      "api.openai.com": {
        body: {
          choices: [{ message: { content: "from-callai" } }],
          usage: {},
        },
      },
    });
    globalThis.fetch = spy;

    const text = await callAI("sk-test", "sys", [{ role: "user", content: "x" }], {
      task: TASKS.ALERT_AUTO_ANALYZE,
    });
    expect(text).toBe("from-callai");
  });
});

describe("detectProvider", () => {
  it("recognizes the 5 prefix-based providers", () => {
    expect(detectProvider("sk-ant-foo")).toBe("claude");
    expect(detectProvider("xai-foo")).toBe("grok");
    expect(detectProvider("gsk_foo")).toBe("groq");
    expect(detectProvider("AIzaFoo")).toBe("gemini");
    expect(detectProvider("sk-foo")).toBe("openai");
  });
});

describe("receipts sink registry", () => {
  beforeEach(() => clearReceiptSinks());
  afterEach(() => clearReceiptSinks());

  it("registers + clears sinks idempotently", () => {
    const sink = () => {};
    expect(receiptSinkCount()).toBe(0);
    registerReceiptSink(sink);
    expect(receiptSinkCount()).toBe(1);
    // Idempotent: same reference doesn't double-register.
    registerReceiptSink(sink);
    expect(receiptSinkCount()).toBe(1);
    clearReceiptSinks();
    expect(receiptSinkCount()).toBe(0);
  });
});

// ── Tool-use mode parity with legacy callAIWithTools ───────────────────────

describe("tool-use mode", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearReceiptSinks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearReceiptSinks();
  });

  it("translates Anthropic tool_use response shape", async () => {
    const { spy } = makeFetchStub({
      "api.anthropic.com": {
        body: {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "read_file",
              input: { path: "/x" },
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    });
    globalThis.fetch = spy;

    const result = await callAIWithTools(
      "sk-ant-test",
      "sys",
      [{ role: "user", content: "hi" }],
      [
        {
          name: "read_file",
          description: "read",
          input_schema: { type: "object", properties: {} },
        },
      ],
    );
    expect(result.stopReason).toBe("tool_use");
    if (result.stopReason === "tool_use") {
      expect(result.content[0].type).toBe("tool_use");
    }
  });
});
