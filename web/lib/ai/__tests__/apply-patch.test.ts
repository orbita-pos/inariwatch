import { describe, it, expect } from "vitest";
import { parsePatch, applyPatch, parseAndApply, ApplyPatchError } from "../apply-patch";

describe("parsePatch", () => {
  it("parses a minimal update with one hunk", () => {
    const patch = `*** Begin Patch
*** Update File: src/foo.ts
@@
-const x = 1
+const x = 2
*** End Patch`;
    const p = parsePatch(patch);
    expect(p.ops).toHaveLength(1);
    expect(p.ops[0]).toMatchObject({ op: "update", path: "src/foo.ts" });
    expect((p.ops[0] as { hunks: unknown[] }).hunks).toHaveLength(1);
  });

  it("parses multiple files in one envelope", () => {
    const patch = `*** Begin Patch
*** Update File: a.ts
@@
-a
+A
*** Update File: b.ts
@@
-b
+B
*** End Patch`;
    const p = parsePatch(patch);
    expect(p.ops.map((o) => o.path)).toEqual(["a.ts", "b.ts"]);
  });

  it("parses an Add File op", () => {
    const patch = `*** Begin Patch
*** Add File: new.ts
+export const X = 1
+export const Y = 2
*** End Patch`;
    const p = parsePatch(patch);
    expect(p.ops[0]).toMatchObject({
      op: "add",
      path: "new.ts",
      body: "export const X = 1\nexport const Y = 2",
    });
  });

  it("parses a Delete File op (no body)", () => {
    const patch = `*** Begin Patch
*** Delete File: gone.ts
*** End Patch`;
    const p = parsePatch(patch);
    expect(p.ops[0]).toEqual({ op: "delete", path: "gone.ts" });
  });

  it("tolerates a missing End Patch when at least one op was parsed", () => {
    const patch = `*** Begin Patch
*** Update File: src/foo.ts
@@
-x
+y`;
    const p = parsePatch(patch);
    expect(p.ops).toHaveLength(1);
  });

  it("rejects missing Begin Patch", () => {
    expect(() => parsePatch("*** Update File: foo.ts\n@@\n-a\n+b")).toThrow(ApplyPatchError);
  });

  it("rejects empty path", () => {
    const patch = `*** Begin Patch
*** Update File:
@@
-x
+y
*** End Patch`;
    expect(() => parsePatch(patch)).toThrow(/empty path/);
  });

  it("normalizes CRLF to LF", () => {
    const patch = "*** Begin Patch\r\n*** Update File: foo.ts\r\n@@\r\n-a\r\n+b\r\n*** End Patch\r\n";
    const p = parsePatch(patch);
    expect(p.ops).toHaveLength(1);
  });

  it("preserves context line content including leading whitespace after the space marker", () => {
    const patch = `*** Begin Patch
*** Update File: src/foo.ts
@@
     const indented = 1
-    return indented
+    return indented + 1
*** End Patch`;
    const p = parsePatch(patch);
    const hunk = (p.ops[0] as { hunks: { lines: { kind: string; text: string }[] }[] }).hunks[0];
    expect(hunk.lines[0]).toEqual({ kind: "context", text: "    const indented = 1" });
  });

  it("tolerates space-prefixed marker mode (gpt-4o-mini mistake)", () => {
    // Every "-" and "+" line has an EXTRA leading space before the
    // marker. Context lines keep their standard single-space marker.
    const patch = `*** Begin Patch
*** Update File: a.ts
 @@ -1,2 +1,2 @@
 context line
 -const x = 1
 +const x = 2
*** End Patch`;
    const p = parsePatch(patch);
    const hunk = (p.ops[0] as { hunks: { lines: { kind: string; text: string }[] }[] }).hunks[0];
    expect(hunk.lines.map((l) => l.kind)).toEqual(["context", "remove", "add"]);
    expect(hunk.lines[1].text).toBe("const x = 1");
    expect(hunk.lines[2].text).toBe("const x = 2");
  });

  it("tolerates leading whitespace on envelope keywords", () => {
    // gpt-4o-mini sometimes indents " *** Update File: ..." and
    // " *** End Patch" by one space — parser should still recognize them.
    const patch = `*** Begin Patch
*** Update File: a.ts
@@
-x
+X
 *** Update File: b.ts
@@
-y
+Y
 *** End Patch`;
    const p = parsePatch(patch);
    expect(p.ops).toHaveLength(2);
    expect(p.ops[0].path).toBe("a.ts");
    expect(p.ops[1].path).toBe("b.ts");
  });

  it("pure-insert hunk anchors on last context line (E2E v12 repro)", async () => {
    // The file has 2 doc-comment lines between `export function …{` and
    // the `const validation` line that the model wants to insert after.
    // The model's patch skips those comments. A strict exact/loose
    // match would fail; pass 4 finds `const validation = …` uniquely
    // and inserts after it.
    const files = {
      "discount.ts": [
        `import { validateCoupon } from "./validators";`,
        ``,
        `export async function applyDiscount(code: string) {`,
        `  // Dev asserted non-null here during initial build but never came back`,
        `  // to wire up the unknown-code branch. See route.ts for the contract.`,
        `  const validation = (await validateCoupon(code))!;`,
        ``,
        `  return validation.discount;`,
        `}`,
      ].join("\n"),
    };
    const patch = `*** Begin Patch
*** Update File: discount.ts
@@ -3,5 +3,9 @@
 export async function applyDiscount(code: string) {
   const validation = (await validateCoupon(code))!;

+  if (!validation) {
+    throw new Error("Invalid");
+  }
+
   return validation.discount;
 }
*** End Patch`;
    const mockRead = async (p: string) => files[p as keyof typeof files] ?? null;
    const result = await parseAndApply(patch, mockRead);
    expect(result.changed[0].content).toContain("if (!validation)");
    expect(result.changed[0].content).toContain(`throw new Error("Invalid")`);
    // Doc comments preserved
    expect(result.changed[0].content).toContain("// Dev asserted non-null");
  });

  it("does NOT enter space-prefix mode when traditional markers are present", () => {
    // Hunk mixes traditional and space-prefixed — stick with traditional.
    // Line " -old" should be parsed as context "- old" (rare edge case —
    // content legitimately starting with a dash).
    const patch = `*** Begin Patch
*** Update File: a.ts
@@
 normal context
-old
+new
*** End Patch`;
    const p = parsePatch(patch);
    const hunk = (p.ops[0] as { hunks: { lines: { kind: string; text: string }[] }[] }).hunks[0];
    expect(hunk.lines.map((l) => l.kind)).toEqual(["context", "remove", "add"]);
    expect(hunk.lines[1].text).toBe("old");
    expect(hunk.lines[2].text).toBe("new");
  });
});

describe("applyPatch", () => {
  const mockRead = (files: Record<string, string>) =>
    async (path: string): Promise<string | null> =>
      files[path] ?? null;

  it("applies a single-hunk update", async () => {
    const files = { "src/foo.ts": "line1\nline2\nline3\n" };
    const result = await parseAndApply(
      `*** Begin Patch
*** Update File: src/foo.ts
@@
 line1
-line2
+LINE2
 line3
*** End Patch`,
      mockRead(files),
    );
    expect(result.changed[0].content).toBe("line1\nLINE2\nline3\n");
  });

  it("applies multiple hunks in order", async () => {
    const files = {
      "src/foo.ts": ["one", "two", "three", "four", "five"].join("\n"),
    };
    const result = await parseAndApply(
      `*** Begin Patch
*** Update File: src/foo.ts
@@
-one
+ONE
@@
-four
+FOUR
*** End Patch`,
      mockRead(files),
    );
    expect(result.changed[0].content.split("\n")).toEqual([
      "ONE", "two", "three", "FOUR", "five",
    ]);
  });

  it("add-file creates a new file", async () => {
    const result = await parseAndApply(
      `*** Begin Patch
*** Add File: src/new.ts
+export const X = 1
+export const Y = 2
*** End Patch`,
      mockRead({}),
    );
    expect(result.changed[0]).toMatchObject({
      op: "add",
      path: "src/new.ts",
      content: "export const X = 1\nexport const Y = 2",
    });
  });

  it("add-file refuses to overwrite an existing file", async () => {
    const files = { "src/new.ts": "existing" };
    await expect(
      parseAndApply(
        `*** Begin Patch
*** Add File: src/new.ts
+something
*** End Patch`,
        mockRead(files),
      ),
    ).rejects.toThrow(/already exists/);
  });

  it("update-file errors when the file doesn't exist", async () => {
    await expect(
      parseAndApply(
        `*** Begin Patch
*** Update File: missing.ts
@@
-x
+y
*** End Patch`,
        mockRead({}),
      ),
    ).rejects.toThrow(/file not found/);
  });

  it("errors with a useful preview when a hunk doesn't match", async () => {
    const files = { "src/foo.ts": "totally different content\n" };
    await expect(
      parseAndApply(
        `*** Begin Patch
*** Update File: src/foo.ts
@@
-expected
+actual
*** End Patch`,
        mockRead(files),
      ),
    ).rejects.toThrow(/did not match file contents/);
  });

  it("loose match: tolerates trailing whitespace on blank context lines", async () => {
    const files = {
      // file has NO trailing whitespace on the blank line between "one" and "two"
      "src/foo.ts": "one\n\nfunction x() {\n  return 1\n}\n",
    };
    const result = await parseAndApply(
      // Model emits a blank context line with trailing spaces — our loose
      // matcher normalizes it.
      `*** Begin Patch
*** Update File: src/foo.ts
@@
 one

 function x() {
-  return 1
+  return 2
 }
*** End Patch`,
      mockRead(files),
    );
    expect(result.changed[0].content).toContain("return 2");
  });

  it("delete-file marks for removal with empty content", async () => {
    const files = { "src/gone.ts": "anything" };
    const result = await parseAndApply(
      `*** Begin Patch
*** Delete File: src/gone.ts
*** End Patch`,
      mockRead(files),
    );
    expect(result.changed[0]).toEqual({
      op: "delete",
      path: "src/gone.ts",
      content: "",
    });
  });

  it("handles a realistic checkout null-check fix", async () => {
    const before = [
      "export async function POST(req: Request) {",
      "  const { cartItems, shippingAddress } = await req.json()",
      "",
      "  const city = shippingAddress.city.toUpperCase()",
      "  const zip = shippingAddress.zip.trim()",
      "",
      "  return NextResponse.json({ city, zip })",
      "}",
    ].join("\n");
    const result = await parseAndApply(
      `*** Begin Patch
*** Update File: app/api/checkout/route.ts
@@
   const { cartItems, shippingAddress } = await req.json()

+  if (!shippingAddress?.city || !shippingAddress?.zip) {
+    return NextResponse.json({ error: "Shipping address required" }, { status: 400 })
+  }
+
   const city = shippingAddress.city.toUpperCase()
*** End Patch`,
      mockRead({ "app/api/checkout/route.ts": before }),
    );
    expect(result.changed[0].content).toContain("Shipping address required");
    expect(result.changed[0].content).toContain("shippingAddress.city.toUpperCase()");
  });
});
