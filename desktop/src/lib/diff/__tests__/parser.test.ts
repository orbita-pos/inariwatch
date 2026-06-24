import { describe, expect, it } from "vitest";

import { parseUnifiedDiff } from "@/lib/diff/parser";

describe("parseUnifiedDiff", () => {
  it("parses a simple unified diff with one hunk", () => {
    const input = [
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,4 +1,4 @@",
      " line one",
      "-line two",
      "+line two!",
      " line three",
      " line four",
    ].join("\n");

    const result = parseUnifiedDiff(input);

    expect(result.binary).toBe(false);
    expect(result.hunks).toHaveLength(1);
    const hunk = result.hunks[0]!;
    expect(hunk.oldStart).toBe(1);
    expect(hunk.oldLines).toBe(4);
    expect(hunk.newStart).toBe(1);
    expect(hunk.newLines).toBe(4);
    expect(hunk.lines).toHaveLength(5);
    expect(hunk.lines[0]!).toMatchObject({
      type: "context",
      content: "line one",
      oldLineNo: 1,
      newLineNo: 1,
    });
    expect(hunk.lines[1]!).toMatchObject({
      type: "del",
      content: "line two",
      oldLineNo: 2,
      newLineNo: null,
    });
    expect(hunk.lines[2]!).toMatchObject({
      type: "add",
      content: "line two!",
      oldLineNo: null,
      newLineNo: 2,
    });
    expect(hunk.lines[3]!).toMatchObject({
      type: "context",
      content: "line three",
      oldLineNo: 3,
      newLineNo: 3,
    });
    expect(hunk.lines[4]!).toMatchObject({
      type: "context",
      content: "line four",
      oldLineNo: 4,
      newLineNo: 4,
    });
  });

  it("parses a multi-hunk diff and tracks line numbers across hunks", () => {
    const input = [
      "--- a/bar.ts",
      "+++ b/bar.ts",
      "@@ -10,3 +10,4 @@ function login()",
      " before",
      "+inserted",
      " mid",
      " after",
      "@@ -50,2 +51,2 @@",
      "-removed",
      "+replaced",
      " stable",
    ].join("\n");

    const result = parseUnifiedDiff(input);

    expect(result.binary).toBe(false);
    expect(result.hunks).toHaveLength(2);

    const [h1, h2] = result.hunks;
    expect(h1!.heading).toBe("function login()");
    expect(h1!.oldStart).toBe(10);
    expect(h1!.newStart).toBe(10);
    // Old cursor should NOT advance for an `add` line; new cursor does.
    const inserted = h1!.lines.find((l) => l.type === "add")!;
    expect(inserted.oldLineNo).toBeNull();
    expect(inserted.newLineNo).toBe(11);

    expect(h2!.oldStart).toBe(50);
    expect(h2!.newStart).toBe(51);
    expect(h2!.lines).toHaveLength(3);
    expect(h2!.lines[0]!.type).toBe("del");
    expect(h2!.lines[0]!.oldLineNo).toBe(50);
    expect(h2!.lines[1]!.type).toBe("add");
    expect(h2!.lines[1]!.newLineNo).toBe(51);
    expect(h2!.lines[2]!.type).toBe("context");
  });

  it("handles binary diffs gracefully", () => {
    const input = "Binary files a/logo.png and b/logo.png differ";
    const result = parseUnifiedDiff(input);
    expect(result.binary).toBe(true);
    expect(result.hunks).toHaveLength(0);
  });
});
