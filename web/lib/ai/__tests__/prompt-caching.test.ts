/**
 * Tests for the Claude prompt-caching helpers in client.ts.
 *
 * Validates that cache_control breakpoints land on the expected
 * positions. Does not test actual cache hit rate — that's an Anthropic
 * API property we cannot assert on in unit tests.
 */

import { describe, it, expect, vi } from "vitest";

// The helpers don't touch db/redis/ai — no mocks required. But client.ts
// imports other modules that DO touch the DB at load time, so stub them
// to keep the test environment clean.
vi.mock("@/lib/db", () => ({}));
vi.mock("@/lib/redis", () => ({ getRedis: () => null }));

import {
  buildToolsWithCache,
  buildMessagesWithCache,
  type AIMessage,
  type ToolDefinition,
} from "../client";

const tool = (name: string): ToolDefinition => ({
  name,
  description: `tool ${name}`,
  input_schema: { type: "object", properties: {}, required: [] },
});

describe("buildToolsWithCache", () => {
  it("returns [] when tools is empty", () => {
    expect(buildToolsWithCache([])).toEqual([]);
  });

  it("tags only the last tool with cache_control", () => {
    const out = buildToolsWithCache([tool("a"), tool("b"), tool("c")]);
    expect(out).toHaveLength(3);
    expect(out[0]).not.toHaveProperty("cache_control");
    expect(out[1]).not.toHaveProperty("cache_control");
    expect(out[2]).toHaveProperty("cache_control", { type: "ephemeral" });
  });

  it("preserves each tool's name + description + input_schema", () => {
    const out = buildToolsWithCache([tool("a")]);
    expect(out[0]).toMatchObject({
      name: "a",
      description: "tool a",
      input_schema: { type: "object", properties: {}, required: [] },
      cache_control: { type: "ephemeral" },
    });
  });
});

describe("buildMessagesWithCache", () => {
  it("returns [] when messages is empty", () => {
    expect(buildMessagesWithCache([])).toEqual([]);
  });

  it("promotes a string last message to a text block + tags it", () => {
    const out = buildMessagesWithCache([{ role: "user", content: "hello" }]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
    expect(out[0].content).toEqual([
      { type: "text", text: "hello", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("tags only the LAST block of the LAST message", () => {
    const msgs: AIMessage[] = [
      { role: "user", content: "turn1 user" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "t1" },
          { type: "tool_use", id: "u1", name: "read_file", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "u1", content: "result text" },
        ],
      },
    ];
    const out = buildMessagesWithCache(msgs);
    expect(out).toHaveLength(3);
    // First message content untouched beyond string-to-block normalization
    expect(out[0].content).toBe("turn1 user");
    // Middle message content untouched (array of blocks, no cache_control
    // on either block)
    const mid = out[1].content as Array<Record<string, unknown>>;
    expect(mid[0]).not.toHaveProperty("cache_control");
    expect(mid[1]).not.toHaveProperty("cache_control");
    // Last message's last block gets cache_control
    const last = out[2].content as Array<Record<string, unknown>>;
    expect(last[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "u1",
      content: "result text",
      cache_control: { type: "ephemeral" },
    });
  });

  it("does not mutate the caller's input array", () => {
    const orig: AIMessage[] = [
      { role: "user", content: [{ type: "text", text: "unchanged" }] },
    ];
    const snapshot = JSON.parse(JSON.stringify(orig));
    buildMessagesWithCache(orig);
    expect(orig).toEqual(snapshot);
  });

  it("leaves last message untouched when content is an empty array", () => {
    const out = buildMessagesWithCache([{ role: "user", content: [] }]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toEqual([]);
  });
});
