import { describe, expect, it } from "vitest";
import { verifySyntax } from "../verifier";

describe("verifySyntax", () => {
  it("passes valid TS", () => {
    const result = verifySyntax([
      { path: "foo.ts", content: "export const x: number = 1;\nexport function f() { return x + 1; }\n" },
    ]);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("passes valid TSX", () => {
    const result = verifySyntax([
      {
        path: "Foo.tsx",
        content:
          "import React from 'react';\nexport function Foo() { return <div>hi</div>; }\n",
      },
    ]);
    expect(result.ok).toBe(true);
  });

  it("catches the orphan catch that shipped in PR #4 E2E v5", () => {
    const content = [
      "export async function POST(req: Request) {",
      "  const { cart, couponCode } = await req.json();",
      "",
      "  try {",
      "    const result = await applyDiscount(cart, couponCode);",
      "    return NextResponse.json(result);",
      "  }",
      "  } catch (error) {",
      "    return NextResponse.json({ error: 'x' }, { status: 500 });",
      "  }",
      "}",
    ].join("\n");
    const result = verifySyntax([{ path: "route.ts", content }]);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("catches the unreachable-return that the route.ts fix shipped in v6", () => {
    // The concrete bug: try/return/return sequence with no catch.
    const content = [
      "export async function POST(req: Request) {",
      "  try {",
      "    const result = await applyDiscount(cart, couponCode);",
      "    return NextResponse.json(result);",
      "  }",
      "}",
    ].join("\n");
    const result = verifySyntax([{ path: "route.ts", content }]);
    expect(result.ok).toBe(false);
  });

  it("catches unterminated string literal", () => {
    const result = verifySyntax([
      { path: "a.ts", content: "const x = 'unterminated" },
    ]);
    expect(result.ok).toBe(false);
  });

  it("catches unmatched brace", () => {
    const result = verifySyntax([
      { path: "a.ts", content: "function f() {\n  return 1;\n" },
    ]);
    expect(result.ok).toBe(false);
  });

  it("skips non-JS/TS files", () => {
    // Python / Rust / JSON — we don't parse these in v1.
    const result = verifySyntax([
      { path: "README.md", content: "# hello\n\nnot valid JS but we don't care\n" },
      { path: "cargo.toml", content: "[[ this is malformed TOML ]]" },
      { path: "config.py", content: "this is NOT valid python either" },
    ]);
    expect(result.ok).toBe(true);
  });

  it("reports the right file + line when one of N files is broken", () => {
    const result = verifySyntax([
      { path: "good.ts", content: "export const x = 1;\n" },
      { path: "bad.ts", content: "export function f() {\n  return 1;\n" },
      { path: "also-good.ts", content: "export const y = 2;\n" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors.every((e) => e.path === "bad.ts")).toBe(true);
    expect(result.errors[0].line).toBeTypeOf("number");
  });
});
