// dispatchStream() tests — v0.3 S2.5.
//
// Stubs global.fetch to return SSE bodies + asserts:
//   - happy path streams deltas + emits a receipt on done
//   - unsupported provider falls back to complete() and emits one chunk
//   - mid-stream error propagates without a receipt
//   - abort signal interrupts the iteration

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchStream } from "../dispatch";
import { TASKS } from "../tasks";
import {
  clearReceiptSinks,
  registerReceiptSink,
  type RouterReceipt,
} from "../receipts";

function sseStream(events: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const e of events) controller.enqueue(encoder.encode(e));
      controller.close();
    },
  });
}

describe("dispatchStream()", () => {
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

  it("yields deltas + emits receipt on done", async () => {
    const events = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ];
    globalThis.fetch = vi.fn(
      async () =>
        new Response(sseStream(events), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    ) as typeof globalThis.fetch;

    const collected: string[] = [];
    let final: RouterReceipt | undefined;
    for await (const chunk of dispatchStream({
      mode: "stream",
      task: TASKS.CHAT_CONVERSATIONAL,
      apiKey: "sk-test",
      systemPrompt: "s",
      messages: [{ role: "user", content: "hi" }],
    })) {
      if (chunk.delta) collected.push(chunk.delta);
      if (chunk.done) final = chunk.receipt;
    }

    expect(collected.join("")).toBe("Hello world");
    expect(final).toBeDefined();
    expect(final?.task).toBe(TASKS.CHAT_CONVERSATIONAL);
    expect(final?.substrate).toBe("cloud");
    expect(receipts).toHaveLength(1);
  });

  it("falls back to complete() when streamComplete throws stream-not-supported", async () => {
    // Force the unsupported branch by passing a gpt-5 model name — openai.ts
    // throws stream-not-supported synchronously for the gpt-5 family.
    let completeCalls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      // streamComplete uses /chat/completions with stream:true; complete()
      // uses the same URL but stream is implicit. Check the body.
      completeCalls++;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "fallback-text" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
      void url;
    }) as typeof globalThis.fetch;

    const collected: string[] = [];
    for await (const chunk of dispatchStream({
      mode: "stream",
      // CODE_FIX_SINGLE_SHOT routes openai-primary (per rules.ts).
      // The previous task here was CHAT_CONVERSATIONAL which Sonnet's
      // migration repointed to Together, breaking the gpt-5 model arg
      // that this test relies on to trigger the stream-not-supported
      // branch in openai.ts (Together doesn't have gpt-5).
      task: TASKS.CODE_FIX_SINGLE_SHOT,
      apiKey: "sk-test",
      systemPrompt: "s",
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-5.4",
    })) {
      if (chunk.delta) collected.push(chunk.delta);
    }

    expect(collected.join("")).toBe("fallback-text");
    expect(completeCalls).toBeGreaterThan(0);
  });

  it("propagates mid-stream errors without emitting a receipt", async () => {
    const events = [
      'data: {"choices":[{"delta":{"content":"start"}}]}\n\n',
    ];
    // First yield delta, then break the body to simulate disconnect.
    //
    // NOTE: per WHATWG Streams, calling `controller.error()` *synchronously*
    // after `controller.enqueue()` in the same start() tick discards the
    // queued chunk and the very first reader.read() rejects with the error
    // — the consumer never sees the delta. That's not what real
    // mid-stream errors look like (TCP has at least some scheduling delay
    // between bytes and a network error). Pull/push with a microtask gap
    // so the consumer reads + decodes the delta BEFORE the error lands.
    const broken = new ReadableStream({
      async pull(controller) {
        const enc = new TextEncoder();
        for (const e of events) controller.enqueue(enc.encode(e));
        // Yield the event-loop so the upstream reader picks the bytes up
        // before we kill the stream.
        await new Promise((r) => setTimeout(r, 0));
        controller.error(new Error("network died mid-stream"));
      },
    });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(broken, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    ) as typeof globalThis.fetch;

    let saw = "";
    let threw = false;
    try {
      for await (const chunk of dispatchStream({
        mode: "stream",
        task: TASKS.CHAT_CONVERSATIONAL,
        apiKey: "sk-test",
        systemPrompt: "s",
        messages: [{ role: "user", content: "hi" }],
      })) {
        if (chunk.delta) saw += chunk.delta;
      }
    } catch {
      threw = true;
    }
    expect(saw).toBe("start");
    expect(threw).toBe(true);
    expect(receipts).toHaveLength(0);
  });

  it("Anthropic stream emits content_block_delta tokens", async () => {
    const events = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
      'data: {"type":"content_block_delta","delta":{"text":"hello"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"text":" claude"}}\n\n',
      'data: {"type":"message_delta","usage":{"output_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ];
    globalThis.fetch = vi.fn(
      async () =>
        new Response(sseStream(events), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    ) as typeof globalThis.fetch;

    const collected: string[] = [];
    for await (const chunk of dispatchStream({
      mode: "stream",
      task: TASKS.CHAT_CONVERSATIONAL,
      apiKey: "sk-ant-test",
      systemPrompt: "s",
      messages: [{ role: "user", content: "hi" }],
    })) {
      if (chunk.delta) collected.push(chunk.delta);
    }
    expect(collected.join("")).toBe("hello claude");
    expect(receipts[0]?.provider).toBe("claude");
  });

  // ── S6.5 tool streaming through dispatchStream ──────────────────────────

  it("forwards tools[] in the request body to the OpenAI-compat provider", async () => {
    let observedBody: Record<string, unknown> | null = null;
    const events = [
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) {
        observedBody = JSON.parse(init.body as string);
      }
      return new Response(sseStream(events), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof globalThis.fetch;

    for await (const _ of dispatchStream({
      mode: "stream",
      task: TASKS.CHAT_CONVERSATIONAL,
      apiKey: "sk-test",
      systemPrompt: "s",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "cloud.list_projects",
          description: "List the user's projects in the cloud workspace.",
          input_schema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    })) {
      // drain
      void _;
    }

    expect(observedBody).not.toBeNull();
    const wireTools = (observedBody as { tools?: unknown[] }).tools;
    expect(Array.isArray(wireTools)).toBe(true);
    expect(wireTools).toHaveLength(1);
    const t0 = wireTools![0] as { type: string; function: { name: string; description: string; parameters: unknown } };
    expect(t0.type).toBe("function");
    // The agent registry's name `cloud.list_projects` contains a dot, but
    // Together/OpenAI enforce `^[a-zA-Z0-9_-]+$` on function.name. The
    // provider sanitizes the outbound name and reverse-maps it on the
    // inbound tool_call delta (asserted in the next test). The dot
    // becomes a hyphen — choice is reversible because tool names are
    // single-namespace + underscore-separated action.
    expect(t0.function.name).toBe("cloud-list_projects");
    expect(t0.function.parameters).toMatchObject({ type: "object" });
  });

  it("surfaces tool_call deltas as StreamChunk.toolCall + finishReason on close", async () => {
    // Two-chunk tool call assembly: first chunk announces the function,
    // second chunk fills in arguments; terminal chunk carries
    // finish_reason: "tool_calls".
    // Together echoes back the SANITIZED name (`cloud-list_projects`)
    // because that's what we sent it. The provider's reverse-map then
    // restores the original dotted name (`cloud.list_projects`) before
    // yielding the StreamChunk.toolCall — verifying the round-trip the
    // assertions below depend on.
    const events = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","function":{"name":"cloud-list_projects"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"limit\\":5}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":7,"completion_tokens":4}}\n\n',
      "data: [DONE]\n\n",
    ];
    globalThis.fetch = vi.fn(
      async () =>
        new Response(sseStream(events), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    ) as typeof globalThis.fetch;

    const toolCalls: Array<{ index: number; id?: string; name?: string; argsDelta: string }> = [];
    let finalFinishReason: string | undefined;
    for await (const chunk of dispatchStream({
      mode: "stream",
      task: TASKS.CHAT_CONVERSATIONAL,
      apiKey: "sk-test",
      systemPrompt: "s",
      messages: [{ role: "user", content: "list projects" }],
      tools: [
        {
          name: "cloud.list_projects",
          description: "List projects.",
          input_schema: { type: "object" },
        },
      ],
    })) {
      if (chunk.toolCall) {
        toolCalls.push({
          index: chunk.toolCall.index,
          id: chunk.toolCall.id,
          name: chunk.toolCall.name,
          argsDelta: chunk.toolCall.argsDelta,
        });
      }
      if (chunk.done) {
        finalFinishReason = chunk.finishReason;
      }
    }

    // First chunk: function header. Second chunk: arguments slice.
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({
      index: 0,
      id: "call_abc",
      name: "cloud.list_projects",
    });
    expect(toolCalls[1]).toMatchObject({
      index: 0,
      argsDelta: '{"limit":5}',
    });
    expect(toolCalls[1].id).toBeUndefined();
    expect(toolCalls[1].name).toBeUndefined();
    expect(finalFinishReason).toBe("tool_calls");
    // Usage rides on the close.
    expect(receipts[0]?.inputTokens).toBe(7);
  });
});
