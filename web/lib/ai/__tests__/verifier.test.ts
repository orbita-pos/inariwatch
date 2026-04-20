import { describe, expect, it } from "vitest";
import { verifyMechanical, verifySyntax } from "../verifier";

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

describe("verifyMechanical", () => {
  it("passes a clean null-safe fix", () => {
    const content = [
      `import { validateCoupon } from "./validators";`,
      ``,
      `export async function applyDiscount(code: string) {`,
      `  const validation = await validateCoupon(code);`,
      `  if (!validation) throw new Error("Invalid");`,
      `  return validation.discount * 100;`,
      `}`,
    ].join("\n");
    const r = verifyMechanical([{ path: "a.ts", content }], "null reference on validation.discount");
    expect(r.ok).toBe(true);
  });

  // Detector 1: duplicate imports
  it("catches duplicate imports (the PR #5 E2E bug)", () => {
    const content = [
      `import { validateCoupon } from "./validators";`,
      `// some other line`,
      `import { validateCoupon } from "./validators";`,
      `export const x = 1;`,
    ].join("\n");
    const r = verifyMechanical([{ path: "a.ts", content }], "null reference");
    expect(r.ok).toBe(false);
    expect(r.issue).toContain("duplicate import");
    expect(r.issue).toContain("validators");
    expect(r.issue).toContain(":3");
  });

  it("does not false-positive on different import specifiers", () => {
    const content = [
      `import { a } from "./mod-a";`,
      `import { b } from "./mod-b";`,
    ].join("\n");
    const r = verifyMechanical([{ path: "a.ts", content }], "");
    expect(r.ok).toBe(true);
  });

  // Detector 2: leftover non-null assertion
  it("catches leftover `!` when diagnosis mentions null", () => {
    const content = [
      `export function f(x: { a: string } | null) {`,
      `  if (!x) return "";`,
      `  return x!.a.toUpperCase();`,
      `}`,
    ].join("\n");
    const r = verifyMechanical(
      [{ path: "a.ts", content }],
      "TypeError: cannot read property of null",
    );
    expect(r.ok).toBe(false);
    expect(r.issue).toContain("non-null assertion");
    expect(r.issue).toContain("x!");
  });

  it("does NOT flag `!` when diagnosis is unrelated to null", () => {
    const content = `const el = document.querySelector(".x")!.innerText;`;
    const r = verifyMechanical(
      [{ path: "a.ts", content }],
      "race condition in checkout transaction",
    );
    expect(r.ok).toBe(true);
  });

  it("does NOT flag `!foo` logical-not as non-null assertion", () => {
    const content = `if (!validation) throw new Error("x");\nreturn 1;`;
    const r = verifyMechanical([{ path: "a.ts", content }], "null reference");
    expect(r.ok).toBe(true);
  });

  // Detector 3: dead code after return / throw
  it("catches unreachable statement after return", () => {
    const content = [
      `export function f() {`,
      `  return 1;`,
      `  return 2;`,
      `}`,
    ].join("\n");
    const r = verifyMechanical([{ path: "a.ts", content }], "");
    expect(r.ok).toBe(false);
    expect(r.issue).toContain("unreachable");
  });

  it("catches unreachable statement after throw", () => {
    const content = [
      `export function f() {`,
      `  throw new Error("x");`,
      `  console.log("never");`,
      `}`,
    ].join("\n");
    const r = verifyMechanical([{ path: "a.ts", content }], "");
    expect(r.ok).toBe(false);
    expect(r.issue).toContain("unreachable");
  });

  it("allows `return` immediately followed by a closing brace", () => {
    const content = [
      `export function f() {`,
      `  return 1;`,
      `}`,
    ].join("\n");
    const r = verifyMechanical([{ path: "a.ts", content }], "");
    expect(r.ok).toBe(true);
  });

  it("allows `return` followed by comment or blank", () => {
    const content = [
      `export function f() {`,
      `  return 1;`,
      ``,
      `  // trailing comment outside function scope`,
      `}`,
    ].join("\n");
    const r = verifyMechanical([{ path: "a.ts", content }], "");
    expect(r.ok).toBe(true);
  });

  it("skips non-JS/TS files", () => {
    const r = verifyMechanical(
      [{ path: "README.md", content: "import x from 'y'\nimport x from 'y'\n" }],
      "null",
    );
    expect(r.ok).toBe(true);
  });

  // Detector 0: duplicate variable declaration (E2E v11 bug)
  it("catches const declared twice in same function scope", () => {
    const content = [
      `export async function applyDiscount(code: string) {`,
      `  const validation = await validateCoupon(code);`,
      `  if (!validation) throw new Error("invalid");`,
      `  const validation = (await validateCoupon(code))!;`,
      `  return validation.discount;`,
      `}`,
    ].join("\n");
    const r = verifyMechanical([{ path: "a.ts", content }], "null reference");
    expect(r.ok).toBe(false);
    expect(r.issue).toContain("duplicate");
    expect(r.issue).toContain("validation");
  });

  it("catches let + let shadowing in same block", () => {
    const content = `function f() { let x = 1; let x = 2; return x; }`;
    const r = verifyMechanical([{ path: "a.ts", content }], "");
    expect(r.ok).toBe(false);
    expect(r.issue).toContain("duplicate");
  });

  it("allows shadowing in a nested inner block", () => {
    const content = [
      `function f(cond: boolean) {`,
      `  const x = 1;`,
      `  if (cond) {`,
      `    const x = 2;`,
      `    return x;`,
      `  }`,
      `  return x;`,
      `}`,
    ].join("\n");
    const r = verifyMechanical([{ path: "a.ts", content }], "");
    expect(r.ok).toBe(true);
  });

  it("allows same name across sibling functions", () => {
    const content = [
      `function a() { const x = 1; return x; }`,
      `function b() { const x = 2; return x; }`,
    ].join("\n");
    const r = verifyMechanical([{ path: "a.ts", content }], "");
    expect(r.ok).toBe(true);
  });

  it("does not flag destructuring patterns that legitimately reuse names", () => {
    const content = [
      `function f(arr: { x: number }[]) {`,
      `  for (const { x } of arr) {`,
      `    console.log(x);`,
      `  }`,
      `  const { x } = arr[0];`,
      `  return x;`,
      `}`,
    ].join("\n");
    // The for-of body's `x` is a nested pattern at a different block
    // scope, so no flag.
    const r = verifyMechanical([{ path: "a.ts", content }], "");
    expect(r.ok).toBe(true);
  });
});
