/**
 * Fase 3 — worker context-compaction tests.
 *
 * These cover the invariants that matter for the phase-boundary flow:
 *   - Below threshold: unchanged, digest is empty.
 *   - Above threshold: first user preserved, last N turns preserved
 *     verbatim, middle replaced by a single user-role digest message.
 *   - tool_use ↔ tool_result pairs in the tail are NOT orphaned.
 *   - The digest mentions files read and failed apply_patch attempts
 *     so the fix-phase model has the context it needs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AIMessage, ContentBlock, ToolResultBlock } from "../ai-client.js";
import { compactMessages, estimatedChars, shouldCompact } from "../context-compaction.js";

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
  it("false below threshold", () => {
    const msgs = [userMsg("a"), asstText("b"), userMsg("c")];
    assert.equal(shouldCompact(msgs), false);
  });

  it("true above the default 14-message threshold", () => {
    const msgs: AIMessage[] = Array.from({ length: 16 }, (_, i) =>
      i % 2 === 0 ? userMsg(`u${i}`) : asstText(`a${i}`),
    );
    assert.equal(shouldCompact(msgs), true);
  });
});

describe("compactMessages — below threshold", () => {
  it("returns messages unchanged, empty digest", () => {
    const msgs = [userMsg("seed"), asstText("reply"), userMsg("followup")];
    const { messages, compactedFrom, compactedTo, digest } = compactMessages(msgs, { thresholdMessages: 10 });
    assert.equal(messages.length, 3);
    assert.equal(compactedFrom, 3);
    assert.equal(compactedTo, 3);
    assert.equal(digest, "");
  });
});

describe("compactMessages — above threshold, with tool pairs", () => {
  it("preserves first user + last N turns, inserts digest in between", () => {
    const msgs: AIMessage[] = [userMsg("BUG: foo is undefined")];
    // 8 middle turns (16 messages) of read_file/tool_result alternation
    for (let i = 0; i < 8; i++) {
      msgs.push(asstToolUse("read_file", `rf_${i}`, { path: `src/file${i}.ts` }));
      msgs.push(userToolResult(`rf_${i}`, `// contents of file${i}`));
    }
    // 2 last turns we want kept verbatim
    msgs.push(asstToolUse("apply_patch", "ap_1", { patch: "x" }));
    msgs.push(userToolResult("ap_1", "apply_patch succeeded"));
    msgs.push(asstToolUse("run_command", "rc_1", { command: "npx tsc --noEmit" }));
    msgs.push(userToolResult("rc_1", "Exit code: 0"));

    const { messages, compactedFrom, compactedTo, digest } = compactMessages(msgs, {
      thresholdMessages: 10,
      keepLastTurns: 2,
    });

    assert.ok(compactedFrom > compactedTo, "must actually shrink");
    // seed + digest + last 2 turns (4 messages) = 6
    assert.equal(compactedTo, 6);
    // First message is still the seed.
    assert.equal(messages[0].role, "user");
    assert.equal(messages[0].content, "BUG: foo is undefined");
    // Digest block is a plain-text user message.
    assert.equal(messages[1].role, "user");
    assert.equal(typeof messages[1].content, "string");
    assert.match(messages[1].content as string, /context compacted/i);
    assert.match(digest, /Files read/);
    // Last verbatim turns intact.
    assert.equal(messages[messages.length - 2].role, "assistant");
    assert.equal(messages[messages.length - 1].role, "user");
  });

  it("never orphans a tool_use by cutting before its tool_result", () => {
    const msgs: AIMessage[] = [userMsg("BUG")];
    for (let i = 0; i < 10; i++) {
      msgs.push(asstToolUse("read_file", `id_${i}`, { path: `src/f${i}.ts` }));
      msgs.push(userToolResult(`id_${i}`, `// f${i}`));
    }

    const { messages } = compactMessages(msgs, { thresholdMessages: 5, keepLastTurns: 2 });

    // Walk the tail — every tool_result should have a preceding tool_use in
    // the same tail. We scan pair-by-pair starting from the digest block.
    for (let i = 2; i < messages.length; i += 2) {
      assert.equal(messages[i].role, "assistant", `pos ${i} should be assistant`);
      assert.equal(messages[i + 1].role, "user",    `pos ${i + 1} should be user`);
    }
  });
});

describe("compactMessages — digest content", () => {
  it("captures failed apply_patch attempts so the fix model avoids them", () => {
    const msgs: AIMessage[] = [userMsg("BUG")];
    for (let i = 0; i < 6; i++) {
      msgs.push(asstToolUse("read_file", `r_${i}`, { path: `src/a${i}.ts` }));
      msgs.push(userToolResult(`r_${i}`, "// contents"));
    }
    msgs.push(asstToolUse("apply_patch", "ap_fail", { patch: "bad" }));
    msgs.push(
      userToolResult("ap_fail", "Error parsing patch: malformed envelope", /*isError*/ true),
    );
    // Last turn we keep verbatim.
    msgs.push(asstToolUse("read_file", "last", { path: "src/x.ts" }));
    msgs.push(userToolResult("last", "contents"));

    const { digest } = compactMessages(msgs, { thresholdMessages: 4, keepLastTurns: 1 });
    assert.match(digest, /FAILED/);
    assert.match(digest, /Error parsing patch/);
  });
});

describe("estimatedChars", () => {
  it("sums string and block contents", () => {
    const n = estimatedChars([
      userMsg("hello"),
      asstToolUse("read_file", "a", { path: "src/f.ts" }),
      userToolResult("a", "contents"),
    ]);
    assert.ok(n > 0);
  });
});
