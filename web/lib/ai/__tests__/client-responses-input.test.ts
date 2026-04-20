/**
 * PR #1 regression tests — buildResponsesInput threading.
 *
 * Exercises the Claude-content-block → Responses API item translator.
 * The critical invariants:
 *
 *   A. On turn 1 (priorOutput undefined) every message becomes a simple
 *      `message` item.
 *   B. The last assistant message is REPLACED by priorOutput items when
 *      provided — this preserves reasoning.encrypted_content + function_call
 *      pairings the server insisted on.
 *   C. Earlier-turn assistant messages that contain tool_use blocks must
 *      emit one `function_call` item per block (not just flatten to text)
 *      so subsequent function_call_output items have a matching call_id.
 *      This was the PR #3 bug surfaced as "No tool call found for
 *      function call output with call_id …" after 2+ tool turns.
 *   D. User messages with tool_result blocks expand to one
 *      function_call_output item per block.
 *   E. Mixed text + tool_use in one assistant message emits BOTH the
 *      text message item AND the function_call items (order: text first).
 */

import { describe, expect, it } from "vitest";
import { buildResponsesInput } from "../client";
import type { AIMessage, ContentBlock } from "../client";

const userString = (text: string): AIMessage => ({ role: "user", content: text });
const asstString = (text: string): AIMessage => ({ role: "assistant", content: text });
const asstTool = (id: string, name: string, input: Record<string, unknown>, text?: string): AIMessage => {
  const blocks: ContentBlock[] = [];
  if (text) blocks.push({ type: "text", text });
  blocks.push({ type: "tool_use", id, name, input });
  return { role: "assistant", content: blocks };
};
const userResult = (toolUseId: string, content: string): AIMessage => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: toolUseId, content }] as ContentBlock[],
});

describe("buildResponsesInput (PR #1)", () => {
  it("turn 1: plain messages become simple message items (no priorOutput)", () => {
    const items = buildResponsesInput([userString("fix the bug")]);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("message");
    expect((items[0] as { role: string }).role).toBe("user");
    expect((items[0] as { content: string }).content).toBe("fix the bug");
  });

  it("last assistant message is REPLACED by priorOutput verbatim", () => {
    const priorOutput = [
      { type: "reasoning", id: "r1", encrypted_content: "xxx" },
      { type: "function_call", call_id: "c1", name: "read_file", arguments: "{}" },
    ];
    const items = buildResponsesInput(
      [userString("task"), asstTool("c1", "read_file", {})],
      priorOutput,
    );
    expect(items).toHaveLength(3);
    expect(items[0].type).toBe("message");
    expect(items[1].type).toBe("reasoning");
    expect(items[2].type).toBe("function_call");
    expect((items[2] as { call_id: string }).call_id).toBe("c1");
  });

  it("user tool_result blocks expand to function_call_output items", () => {
    const items = buildResponsesInput([
      userString("task"),
      asstTool("c1", "read_file", { path: "a.ts" }),
      userResult("c1", "file content here"),
    ]);
    const outputs = items.filter((i) => i.type === "function_call_output");
    expect(outputs).toHaveLength(1);
    expect((outputs[0] as { call_id: string }).call_id).toBe("c1");
    expect((outputs[0] as { output: string }).output).toBe("file content here");
  });

  it("earlier-turn assistants with tool_use emit function_call items (PR #3 pairing fix)", () => {
    // 3-turn history: assistant tool_use (c1) → user result (c1) →
    // assistant tool_use (c2) ← LAST, replaced by priorOutput → user result (c2).
    const priorOutput = [
      { type: "reasoning", id: "r2", encrypted_content: "xxx" },
      { type: "function_call", call_id: "c2", name: "read_file", arguments: "{}" },
    ];
    const items = buildResponsesInput(
      [
        userString("task"),
        asstTool("c1", "read_file", { path: "a.ts" }),
        userResult("c1", "content-a"),
        asstTool("c2", "read_file", { path: "b.ts" }),
      ],
      priorOutput,
    );
    // Expected shape (in order):
    //   message(user=task)
    //   function_call(c1)    ← the NON-last assistant converted, not flattened
    //   function_call_output(c1)
    //   reasoning(r2)        ← priorOutput replaces last assistant
    //   function_call(c2)
    const types = items.map((i) => i.type);
    expect(types).toEqual([
      "message",
      "function_call",
      "function_call_output",
      "reasoning",
      "function_call",
    ]);
    // Every function_call_output has a matching function_call earlier.
    const callIds = new Set(items.filter((i) => i.type === "function_call").map((i) => (i as { call_id: string }).call_id));
    for (const out of items.filter((i) => i.type === "function_call_output")) {
      expect(callIds.has((out as { call_id: string }).call_id)).toBe(true);
    }
  });

  it("assistant with text + tool_use emits text message first, then function_call", () => {
    const priorOutput = [{ type: "function_call", call_id: "cX", name: "f", arguments: "{}" }];
    // Put the mixed-content assistant EARLIER so it goes through the
    // non-last assistant path (the last assistant is replaced by
    // priorOutput entirely).
    const items = buildResponsesInput(
      [
        userString("task"),
        asstTool("c1", "read_file", { path: "a.ts" }, "Let me read that file."),
        userResult("c1", "content"),
        asstTool("c2", "search_code", { query: "x" }),
      ],
      priorOutput,
    );
    // Find the first assistant text message + the c1 function_call.
    const textIdx = items.findIndex(
      (i) => i.type === "message" && (i as { role: string }).role === "assistant",
    );
    const c1Idx = items.findIndex(
      (i) => i.type === "function_call" && (i as { call_id: string }).call_id === "c1",
    );
    expect(textIdx).toBeGreaterThanOrEqual(0);
    expect(c1Idx).toBeGreaterThan(textIdx);
    expect((items[textIdx] as { content: string }).content).toContain("Let me read that file.");
  });

  it("assistant with MULTIPLE tool_use blocks emits one function_call PER block", () => {
    const priorOutput = [{ type: "function_call", call_id: "cLAST", name: "f", arguments: "{}" }];
    // Build a non-last assistant message that calls 3 tools in parallel
    // (think + read_file + search_code).
    const parallel: AIMessage = {
      role: "assistant",
      content: [
        { type: "tool_use", id: "ca", name: "think", input: { thought: "plan" } },
        { type: "tool_use", id: "cb", name: "read_file", input: { path: "x" } },
        { type: "tool_use", id: "cc", name: "search_code", input: { query: "y" } },
      ] as ContentBlock[],
    };
    // Pair each with a tool_result so the next assistant can be the "last".
    const paired: AIMessage = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "ca", content: "(recorded)" },
        { type: "tool_result", tool_use_id: "cb", content: "file x content" },
        { type: "tool_result", tool_use_id: "cc", content: "no hits" },
      ] as ContentBlock[],
    };
    const items = buildResponsesInput(
      [
        userString("task"),
        parallel,
        paired,
        asstTool("cLAST", "apply_patch", { patch: "..." }),
      ],
      priorOutput,
    );
    const ids = items
      .filter((i) => i.type === "function_call")
      .map((i) => (i as { call_id: string }).call_id);
    // ca, cb, cc from the non-last assistant + cLAST from priorOutput.
    expect(ids).toContain("ca");
    expect(ids).toContain("cb");
    expect(ids).toContain("cc");
    expect(ids).toContain("cLAST");
    // Each call must have a corresponding function_call_output (except cLAST
    // which is the current in-flight assistant and hasn't been answered yet).
    const outputs = items
      .filter((i) => i.type === "function_call_output")
      .map((i) => (i as { call_id: string }).call_id);
    expect(outputs).toContain("ca");
    expect(outputs).toContain("cb");
    expect(outputs).toContain("cc");
    expect(outputs).not.toContain("cLAST");
  });
});
