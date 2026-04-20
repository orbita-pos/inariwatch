/**
 * Context compaction for long agentic loops.
 *
 * When an agent loop accumulates many turns (read_file, search_code,
 * failed apply_patch retries, think), the message history grows to the
 * point where the next Responses API call is both expensive AND risky
 * — prompt-cache hit rate drops, encrypted reasoning budget shrinks,
 * and the 128K / 200K context window gets close to full.
 *
 * Strategy (preserves tool-call linkage):
 *
 *   1. Always keep the FIRST user message verbatim (the bug report +
 *      error stack — that's the ground truth).
 *
 *   2. Always keep the LAST N turns verbatim. A "turn" here is an
 *      assistant-with-tool_use paired with the user-with-tool_result
 *      that answers it. Keeping these paired is what stops OpenAI
 *      from 400ing on "function_call_output without function_call".
 *
 *   3. Replace every turn in between with a single synthetic user
 *      message: a digest of what the agent has done so far —
 *      files read, search queries tried, apply_patch attempts that
 *      failed and why. That digest is plain text (no tool_use /
 *      tool_result blocks) so it plays nicely with priorOutput reset.
 *
 *   4. Callers MUST drop `priorOutput` when passing the compacted
 *      history to the next Responses API call — the encrypted
 *      reasoning chain is no longer valid once we rewrote history.
 *
 * We do NOT touch the system prompt — the caller handles that.
 *
 * Tuning: default threshold = 14 messages (~7 turns) and keep-last = 4
 * turns (8 messages). That leaves ~6 messages to compact before we start
 * doing real work.
 */

import type { AIMessage, ContentBlock, TextBlock, ToolResultBlock, ToolUseBlock } from "./client";

export interface CompactionOptions {
  /**
   * Trigger compaction once `messages.length` crosses this threshold.
   * Default: 14 (≈ 7 turns).
   */
  thresholdMessages?: number;
  /**
   * How many of the MOST RECENT turns (assistant + user pair) to keep
   * verbatim after compacting. Default: 4.
   */
  keepLastTurns?: number;
}

export interface CompactionResult {
  messages: AIMessage[];
  compactedFrom: number;
  compactedTo: number;
  digest: string;
}

export function shouldCompact(messages: AIMessage[], opts: CompactionOptions = {}): boolean {
  const threshold = opts.thresholdMessages ?? 14;
  return messages.length > threshold;
}

/**
 * Compact the middle section of a message history. Returns a new array;
 * the input is not mutated. When the history is already short enough,
 * returns messages unchanged.
 */
export function compactMessages(
  messages: AIMessage[],
  opts: CompactionOptions = {},
): CompactionResult {
  const threshold = opts.thresholdMessages ?? 14;
  const keepLastTurns = opts.keepLastTurns ?? 4;
  const keepLastMessages = keepLastTurns * 2;

  if (messages.length <= threshold) {
    return {
      messages: messages.slice(),
      compactedFrom: messages.length,
      compactedTo: messages.length,
      digest: "",
    };
  }

  // Always keep the first user message (task + stack trace). Find it —
  // skip any leading system messages (caller usually keeps those out,
  // but be defensive).
  let firstUserIdx = 0;
  while (firstUserIdx < messages.length && messages[firstUserIdx].role !== "user") {
    firstUserIdx++;
  }
  // Never compact the first user — it's the seed.
  const preamble = messages.slice(0, firstUserIdx + 1);

  // Find a clean cut point that keeps tool_use ↔ tool_result pairs
  // intact in the tail. Start keepLastMessages from the end and walk
  // backwards until the first message is NOT a user-with-tool_results
  // (which would orphan the assistant's tool_use in the compacted
  // section). If the boundary splits a pair, move the cut EARLIER
  // (include one more message) so the pair stays together.
  let tailStart = Math.max(messages.length - keepLastMessages, preamble.length);
  while (tailStart < messages.length) {
    const m = messages[tailStart];
    if (m.role === "user" && Array.isArray(m.content)) {
      const hasToolResult = (m.content as ContentBlock[]).some((b) => b.type === "tool_result");
      if (hasToolResult && tailStart > preamble.length) {
        // The corresponding assistant message is one earlier. Move cut back.
        tailStart--;
        continue;
      }
    }
    break;
  }

  const middle = messages.slice(preamble.length, tailStart);
  const tail = messages.slice(tailStart);

  const digest = buildDigest(middle);
  const digestMessage: AIMessage = {
    role: "user",
    content: digest,
  };

  return {
    messages: [...preamble, digestMessage, ...tail],
    compactedFrom: messages.length,
    compactedTo: preamble.length + 1 + tail.length,
    digest,
  };
}

/**
 * Build a compact plain-text summary of a block of agent turns.
 *
 * The aim is NOT to preserve every word — it is to preserve the facts
 * the model needs to keep going: which files it has seen, what it has
 * searched for, which patches it tried and why they failed. The next
 * turn's model reads this as "background" and can still call read_file
 * again for any file whose content it actually needs byte-for-byte.
 */
function buildDigest(middle: AIMessage[]): string {
  const filesRead = new Set<string>();
  const searches = new Set<string>();
  const listDirs = new Set<string>();
  const thoughts: string[] = [];
  const failedPatches: string[] = [];
  const otherToolCalls: string[] = [];

  for (const m of middle) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content as ContentBlock[]) {
      if (b.type !== "tool_use") continue;
      const tu = b as ToolUseBlock;
      const input = tu.input as Record<string, unknown>;
      switch (tu.name) {
        case "read_file":
          if (typeof input.path === "string") filesRead.add(input.path);
          break;
        case "search_code":
          if (typeof input.query === "string") searches.add(input.query);
          break;
        case "list_directory":
          if (typeof input.prefix === "string") listDirs.add(input.prefix);
          else listDirs.add("(repo root)");
          break;
        case "think":
          if (typeof input.thought === "string") {
            const t = input.thought.slice(0, 200);
            thoughts.push(t);
          }
          break;
        case "apply_patch": {
          // Look for an error in the following user message to know
          // if it failed.
          const idx = middle.indexOf(m);
          const next = middle[idx + 1];
          if (next && next.role === "user" && Array.isArray(next.content)) {
            const tr = (next.content as ContentBlock[]).find(
              (x): x is ToolResultBlock => x.type === "tool_result" && x.tool_use_id === tu.id,
            );
            const content = typeof tr?.content === "string" ? tr.content : "";
            if (content.startsWith("apply_patch error") || tr?.is_error) {
              const firstLine = content.split("\n")[0].slice(0, 180);
              failedPatches.push(firstLine);
            }
          }
          break;
        }
        default:
          otherToolCalls.push(`${tu.name}(${JSON.stringify(input).slice(0, 80)})`);
      }
    }
  }

  const parts: string[] = [
    "[context compacted — prior agent turns summarized]",
    "",
    "What you have already established:",
  ];

  if (filesRead.size > 0) {
    parts.push(`- Files read (do NOT re-read unless you truly need a fresh copy): ${[...filesRead].map((p) => `\`${p}\``).join(", ")}`);
  }
  if (searches.size > 0) {
    parts.push(`- Search queries tried: ${[...searches].map((q) => `"${q}"`).join(", ")}`);
  }
  if (listDirs.size > 0) {
    parts.push(`- Directories listed: ${[...listDirs].join(", ")}`);
  }
  if (thoughts.length > 0) {
    parts.push(`- Your earlier think-tool notes:`);
    for (const t of thoughts.slice(-3)) parts.push(`  • ${t}`);
  }
  if (failedPatches.length > 0) {
    parts.push(`- apply_patch attempts that FAILED (do not repeat the same mistake):`);
    for (const p of failedPatches.slice(-3)) parts.push(`  • ${p}`);
  }
  if (otherToolCalls.length > 0) {
    parts.push(`- Other tool calls made: ${otherToolCalls.slice(-3).join(", ")}`);
  }

  parts.push("");
  parts.push(
    "Use this summary as background; the last few turns below are verbatim. Now continue with the minimum tool call needed to reach a successful apply_patch.",
  );

  return parts.join("\n");
}

/**
 * Total estimated character budget for a message array. Used as a
 * cheap proxy for "is this conversation getting too big" — a real
 * tokenizer would be more accurate but this is O(messages).
 */
export function estimatedChars(messages: AIMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      total += m.content.length;
    } else {
      for (const b of m.content as ContentBlock[]) {
        if (b.type === "text") total += (b as TextBlock).text.length;
        else if (b.type === "tool_use") total += JSON.stringify((b as ToolUseBlock).input).length;
        else if (b.type === "tool_result") {
          const c = (b as ToolResultBlock).content;
          total += typeof c === "string" ? c.length : JSON.stringify(c).length;
        }
      }
    }
  }
  return total;
}
