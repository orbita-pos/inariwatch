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
      task: TASKS.CHAT_CONVERSATIONAL,
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
});
