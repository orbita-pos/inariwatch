import { describe, expect, it } from "vitest";
import { RetryMemory } from "../retry-memory";

const SAMPLE_PATCH = `*** Begin Patch
*** Update File: lib/foo.ts
@@ -1,3 +1,3 @@
 export function foo() {
-  return bar;
+  return bar ?? null;
 }
*** End Patch`;

describe("RetryMemory", () => {
  it("first failure has no hint", () => {
    const mem = new RetryMemory();
    expect(mem.buildHint()).toBe("");
  });

  it("emits a do-not-repeat block on second failure onward", () => {
    const mem = new RetryMemory();
    mem.record(3, SAMPLE_PATCH, "Hunk 1 did not match file contents");
    const hint = mem.buildHint();
    expect(hint).toContain("attempt #2");
    expect(hint).toContain("do NOT repeat");
    expect(hint).toContain("turn 3");
    expect(hint).toContain("lib/foo.ts");
  });

  it("coaches on repeated hunk mismatches with read-first guidance", () => {
    const mem = new RetryMemory();
    mem.record(3, SAMPLE_PATCH, "Hunk 1 did not match file contents");
    mem.record(5, SAMPLE_PATCH, "Hunk 1 did not match file contents");
    const hint = mem.buildHint();
    expect(hint).toContain("read_file on EVERY file");
    expect(hint).toContain("byte-for-byte");
  });

  it("coaches on repeated parse errors with envelope syntax reminder", () => {
    const mem = new RetryMemory();
    mem.record(3, SAMPLE_PATCH, "Parse failed: Expected hunk header");
    mem.record(5, SAMPLE_PATCH, "Parse failed: Patch ended with no operations");
    const hint = mem.buildHint();
    expect(hint).toContain("Parse errors");
    expect(hint).toContain("envelope syntax");
  });

  it("keeps at most 3 prior attempts in the hint body", () => {
    const mem = new RetryMemory();
    for (let i = 1; i <= 5; i++) {
      mem.record(i * 2, SAMPLE_PATCH, `Hunk ${i} mismatch`);
    }
    const hint = mem.buildHint();
    // Attempt numbers shown should be the 3 most recent (turns 6, 8, 10)
    // plus the "attempt #6" header line.
    expect(hint).toContain("attempt #6");
    expect(hint).toContain("turn 6");
    expect(hint).toContain("turn 8");
    expect(hint).toContain("turn 10");
    expect(hint).not.toContain("turn 2");
    expect(hint).not.toContain("turn 4");
  });

  it("counts attempts correctly", () => {
    const mem = new RetryMemory();
    expect(mem.count()).toBe(0);
    mem.record(3, SAMPLE_PATCH, "x");
    expect(mem.count()).toBe(1);
    mem.record(5, SAMPLE_PATCH, "y");
    expect(mem.count()).toBe(2);
  });

  it("fingerprint captures file + hunk header + first remove line", () => {
    const mem = new RetryMemory();
    mem.record(3, SAMPLE_PATCH, "Hunk mismatch");
    const hint = mem.buildHint();
    // fingerprint goes through -> next retry's hint
    mem.record(5, SAMPLE_PATCH, "x");
    const next = mem.buildHint();
    expect(hint).toContain("@@ -1,3 +1,3 @@");
    expect(hint).toContain("-  return bar");
    expect(next).toContain("@@ -1,3 +1,3 @@");
  });
});
