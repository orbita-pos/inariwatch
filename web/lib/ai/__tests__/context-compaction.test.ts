import { describe, expect, it } from "vitest";
import type { AIMessage, ToolResultBlock, ToolUseBlock, ContentBlock } from "../client";
import { compactMessages, estimatedChars, shouldCompact } from "../context-compaction";

const userMsg = (text: string): AIMessage => ({ role: "user", content: text });
const asstText = (text: string): AIMessage => ({ role: "assistant", content: text });
const asstToolUse = (name: string, id: string, input: Record<string, unknown>): AIMessage => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name, input }] as ContentBlock[],
});
const userToolResult = (tool_use_id: string, content: string, isError = false): AIMessage => ({
  role: "user",
  content: [
    { type: "tool_result", tool_use_id, content, is_error: isError } as ToolResultBlock,
  ] as ContentBlock[],
});

describe("shouldCompact", () => {
  it("returns false when below threshold", () => {
    const msgs = [userMsg("a"), asstText("b"), userMsg("c")];
    expect(shouldCompact(msgs)).toBe(false);
  });

  it("returns true when above threshold", () => {
    const msgs = Array.from({ length: 16 }, (_, i) =>
      i % 2 === 0 ? userMsg(`u${i}`) : asstText(`a${i}`),
    );
    expect(shouldCompact(msgs)).toBe(true);
  });

  it("respects custom threshold", () => {
    const msgs = [userMsg("a"), asstText("b"), userMsg("c"), asstText("d")];
    expect(shouldCompact(msgs, { thresholdMessages: 2 })).toBe(true);
    expect(shouldCompact(msgs, { thresholdMessages: 10 })).toBe(false);
  });
});

describe("compactMessages", () => {
  it("returns messages unchanged when short", () => {
    const msgs = [userMsg("task"), asstText("ok"), userMsg("next")];
    const { messages, compactedFrom, compactedTo } = compactMessages(msgs, { thresholdMessages: 10 });
    expect(messages).toEqual(msgs);
    expect(compactedFrom).toBe(3);
    expect(compactedTo).toBe(3);
  });

  it("compacts middle turns, keeps first user + last N turns", () => {
    const msgs: AIMessage[] = [
      userMsg("initial task: fix bug"),
      asstToolUse("read_file", "t1", { path: "a.ts" }),
      userToolResult("t1", "file a content"),
      asstToolUse("read_file", "t2", { path: "b.ts" }),
      userToolResult("t2", "file b content"),
      asstToolUse("search_code", "t3", { query: "foo" }),
      userToolResult("t3", "no matches"),
      asstToolUse("apply_patch", "t4", { patch: "p" }),
      userToolResult("t4", "apply_patch error: hunk mismatch", true),
      asstToolUse("read_file", "t5", { path: "c.ts" }),
      userToolResult("t5", "file c content"),
      asstToolUse("apply_patch", "t6", { patch: "p2" }),
      userToolResult("t6", "apply_patch error: parse fail", true),
      asstToolUse("read_file", "t7", { path: "d.ts" }),
      userToolResult("t7", "file d content"),
      asstToolUse("think", "t8", { thought: "I should look at utils.ts" }),
      userToolResult("t8", "(recorded)"),
    ];
    const { messages, digest } = compactMessages(msgs, {
      thresholdMessages: 5,
      keepLastTurns: 3,
    });

    expect(messages[0]).toEqual(msgs[0]);
    expect(messages[1].role).toBe("user");
    expect(typeof messages[1].content).toBe("string");
    expect(messages[1].content as string).toContain("context compacted");
    expect(messages[1].content as string).toContain("a.ts");
    expect(messages[1].content as string).toContain("apply_patch attempts that FAILED");
    expect(messages.length).toBeLessThan(msgs.length);
    expect(digest.length).toBeGreaterThan(0);

    const tail = messages.slice(-6);
    expect(tail[0].role).toBe("assistant");
    expect(tail[tail.length - 1].role).toBe("user");
  });

  it("never splits a tool_use / tool_result pair across the boundary", () => {
    const msgs: AIMessage[] = [
      userMsg("task"),
      ...Array.from({ length: 6 }, (_, i) => [
        asstToolUse("read_file", `tu${i}`, { path: `f${i}.ts` }),
        userToolResult(`tu${i}`, `content ${i}`),
      ]).flat(),
    ];
    const { messages } = compactMessages(msgs, { thresholdMessages: 5, keepLastTurns: 2 });
    // Every assistant-with-tool_use in the tail must be followed by its matching tool_result.
    for (let i = 1; i < messages.length - 1; i++) {
      const m = messages[i];
      if (m.role === "assistant" && Array.isArray(m.content)) {
        const toolUses = (m.content as ContentBlock[]).filter(
          (b): b is ToolUseBlock => b.type === "tool_use",
        );
        if (toolUses.length === 0) continue;
        const next = messages[i + 1];
        if (next.role !== "user" || !Array.isArray(next.content)) {
          throw new Error(`tool_use at ${i} not followed by tool_result`);
        }
        const results = (next.content as ContentBlock[]).filter(
          (b): b is ToolResultBlock => b.type === "tool_result",
        );
        for (const tu of toolUses) {
          const match = results.find((r) => r.tool_use_id === tu.id);
          expect(match, `no tool_result for ${tu.id}`).toBeTruthy();
        }
      }
    }
  });

  it("digest picks up failed patches for the model to avoid", () => {
    const msgs: AIMessage[] = [
      userMsg("task"),
      asstToolUse("apply_patch", "p1", { patch: "..." }),
      userToolResult("p1", "apply_patch error: Parse failed: Expected hunk header", true),
      asstToolUse("apply_patch", "p2", { patch: "..." }),
      userToolResult("p2", "apply_patch error: Hunk did not match", true),
      asstToolUse("read_file", "r1", { path: "a.ts" }),
      userToolResult("r1", "content"),
      asstToolUse("read_file", "r2", { path: "b.ts" }),
      userToolResult("r2", "content"),
      asstToolUse("read_file", "r3", { path: "c.ts" }),
      userToolResult("r3", "content"),
    ];
    const { digest } = compactMessages(msgs, { thresholdMessages: 4, keepLastTurns: 2 });
    expect(digest).toContain("Parse failed");
    expect(digest).toContain("Hunk did not match");
  });
});

describe("estimatedChars", () => {
  it("sums plain text messages", () => {
    const msgs: AIMessage[] = [userMsg("hello"), asstText("world!")];
    expect(estimatedChars(msgs)).toBe(5 + 6);
  });

  it("handles content-block messages with tool_use and tool_result", () => {
    const msgs: AIMessage[] = [
      asstToolUse("read_file", "id1", { path: "a.ts" }),
      userToolResult("id1", "some file content"),
    ];
    // tool_use: JSON.stringify({path:"a.ts"}).length = 15
    // tool_result: "some file content".length = 17
    expect(estimatedChars(msgs)).toBe(15 + 17);
  });
});
