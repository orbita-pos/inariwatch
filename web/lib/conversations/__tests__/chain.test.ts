/**
 * Pure-module tests for the witness chain hash + verify.
 *
 * The chain commits to `role || canonical(content_json) || prev_hash`.
 * Tampering with any field breaks the chain at that row, which the
 * `/witness verify` slash command surfaces as a tri-state badge.
 */

import { describe, expect, test } from "vitest";

import {
  canonicalJson,
  computeMessageHash,
  verifyChain,
  type ChainRow,
} from "../chain";

describe("canonicalJson", () => {
  test("sorts keys recursively", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ b: { y: 1, x: 2 }, a: 0 })).toBe('{"a":0,"b":{"x":2,"y":1}}');
  });

  test("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  test("primitives passthrough", () => {
    expect(canonicalJson("hi")).toBe('"hi"');
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson(null)).toBe("null");
  });
});

describe("computeMessageHash", () => {
  test("deterministic for identical input", () => {
    const a = computeMessageHash("user", { text: "hi" }, null);
    const b = computeMessageHash("user", { text: "hi" }, null);
    expect(a).toBe(b);
  });

  test("changes when role changes", () => {
    const a = computeMessageHash("user",      { text: "hi" }, null);
    const b = computeMessageHash("assistant", { text: "hi" }, null);
    expect(a).not.toBe(b);
  });

  test("changes when content changes", () => {
    const a = computeMessageHash("user", { text: "hi" }, null);
    const b = computeMessageHash("user", { text: "ho" }, null);
    expect(a).not.toBe(b);
  });

  test("changes when prev hash changes", () => {
    const a = computeMessageHash("user", { text: "hi" }, null);
    const b = computeMessageHash("user", { text: "hi" }, "deadbeef");
    expect(a).not.toBe(b);
  });

  test("returns lowercase hex", () => {
    const h = computeMessageHash("user", { text: "hi" }, null);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("verifyChain", () => {
  function build(rows: { role: string; content: unknown }[]): ChainRow[] {
    let prev: string | null = null;
    return rows.map((r, i) => {
      const hash = computeMessageHash(r.role, r.content, prev);
      const row: ChainRow = {
        id: `m${i}`,
        role: r.role,
        contentJson: r.content,
        prevMessageHash: prev,
        messageHash: hash,
      };
      prev = hash;
      return row;
    });
  }

  test("empty chain verifies as ok", () => {
    const result = verifyChain([]);
    expect(result.ok).toBe(true);
    expect(result.totalMessages).toBe(0);
  });

  test("single message verifies", () => {
    const rows = build([{ role: "assistant", content: { text: "hi" } }]);
    const result = verifyChain(rows);
    expect(result.ok).toBe(true);
    expect(result.totalMessages).toBe(1);
  });

  test("happy-path multi-message chain", () => {
    const rows = build([
      { role: "assistant", content: { text: "boom" } },
      { role: "user",      content: { text: "fix?" } },
      { role: "assistant", content: { text: "yes — patch shipped" } },
    ]);
    const result = verifyChain(rows);
    expect(result.ok).toBe(true);
    expect(result.totalMessages).toBe(3);
    expect(result.firstBreakAt).toBeNull();
  });

  test("tampered content detected", () => {
    const rows = build([
      { role: "assistant", content: { text: "first" } },
      { role: "user",      content: { text: "second" } },
    ]);
    // Tamper with the second row's content but leave its hash unchanged.
    rows[1] = { ...rows[1], contentJson: { text: "ATTACKER" } };
    const result = verifyChain(rows);
    expect(result.ok).toBe(false);
    expect(result.firstBreakAt?.reason).toBe("wrong_hash");
    expect(result.firstBreakAt?.messageId).toBe("m1");
  });

  test("missing hash flagged as unverifiable", () => {
    const rows = build([{ role: "user", content: { text: "hi" } }]);
    rows[0] = { ...rows[0], messageHash: null };
    const result = verifyChain(rows);
    expect(result.ok).toBe(false);
    expect(result.firstBreakAt?.reason).toBe("missing_hash");
  });

  test("wrong prev pointer detected", () => {
    const rows = build([
      { role: "user", content: { text: "a" } },
      { role: "user", content: { text: "b" } },
    ]);
    // Splice in a new prev pointer to misalign the chain.
    rows[1] = { ...rows[1], prevMessageHash: "0".repeat(64) };
    const result = verifyChain(rows);
    expect(result.ok).toBe(false);
    expect(result.firstBreakAt?.reason).toBe("wrong_prev");
  });
});
