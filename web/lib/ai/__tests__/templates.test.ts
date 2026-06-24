import { describe, expect, it } from "vitest";
import {
  applyNonNullAwaitTemplate,
  findNonNullAwaitPattern,
  tryDeterministicFix,
} from "../templates";

describe("findNonNullAwaitPattern", () => {
  it("matches the canonical `const x = (await f())!` pattern", () => {
    const content = [
      `import { validateCoupon } from "./validators";`,
      ``,
      `export async function applyDiscount(code: string) {`,
      `  const validation = (await validateCoupon(code))!;`,
      `  return validation.discount;`,
      `}`,
    ].join("\n");
    const m = findNonNullAwaitPattern(
      [{ path: "a.ts", content }],
      "TypeError: cannot read property of null",
    );
    expect(m).not.toBeNull();
    expect(m!.varName).toBe("validation");
    expect(m!.path).toBe("a.ts");
    expect(m!.line).toBe(4);
    expect(m!.awaitExpr).toContain("validateCoupon");
  });

  it("requires the variable to be dereferenced later", () => {
    const content = [
      `async function f() {`,
      `  const x = (await g())!;`,
      `  return 1;`, // x never read
      `}`,
    ].join("\n");
    const m = findNonNullAwaitPattern(
      [{ path: "a.ts", content }],
      "TypeError: null",
    );
    expect(m).toBeNull();
  });

  it("only fires when diagnosis mentions null / undefined / TypeError", () => {
    const content = `async function f() { const x = (await g())!; return x.y; }`;
    expect(findNonNullAwaitPattern([{ path: "a.ts", content }], "race condition")).toBeNull();
    expect(findNonNullAwaitPattern([{ path: "a.ts", content }], "null reference")).not.toBeNull();
    expect(findNonNullAwaitPattern([{ path: "a.ts", content }], "TypeError")).not.toBeNull();
    expect(findNonNullAwaitPattern([{ path: "a.ts", content }], "undefined behaviour")).not.toBeNull();
  });

  it("skips non-JS/TS files", () => {
    const content = `const x = (await g())!;\nreturn x.y;`;
    expect(
      findNonNullAwaitPattern([{ path: "README.md", content }], "null"),
    ).toBeNull();
  });

  it("returns null when the initializer isn't a non-null await", () => {
    const content = [
      `async function f() {`,
      `  const x = await g();`, // no `!`
      `  return x.y;`,
      `}`,
    ].join("\n");
    expect(
      findNonNullAwaitPattern([{ path: "a.ts", content }], "null"),
    ).toBeNull();
  });

  it("tolerates extra parentheses around the await", () => {
    const content = [
      `async function f() {`,
      `  const x = (((await g())))!;`,
      `  return x.y;`,
      `}`,
    ].join("\n");
    const m = findNonNullAwaitPattern([{ path: "a.ts", content }], "TypeError");
    expect(m).not.toBeNull();
  });

  it("does not match `foo.bar = (await f())!` (not a const declaration)", () => {
    const content = `async function f() { obj.field = (await g())!; return obj.field; }`;
    expect(
      findNonNullAwaitPattern([{ path: "a.ts", content }], "null"),
    ).toBeNull();
  });
});

describe("applyNonNullAwaitTemplate", () => {
  it("rewrites a declaration and inserts a guard line", () => {
    const content = [
      `import { validateCoupon } from "./validators";`,
      ``,
      `export async function applyDiscount(code: string) {`,
      `  const validation = (await validateCoupon(code))!;`,
      `  return validation.discount;`,
      `}`,
    ].join("\n");
    const match = findNonNullAwaitPattern([{ path: "a.ts", content }], "TypeError")!;
    const fix = applyNonNullAwaitTemplate({ path: "a.ts", content }, match);
    const out = fix.content.split("\n");
    // Line 4 (1-indexed) now has the cleaned declaration (no `!`).
    expect(out[3]).toContain("const validation = await validateCoupon(code)");
    expect(out[3]).not.toContain("!");
    // Line 5 is the guard.
    expect(out[4]).toContain(`if (!validation) throw new Error`);
    // Original comment preservation — there's no comment here but
    // the original non-target lines are unchanged.
    expect(out[5]).toBe("  return validation.discount;");
    // Explanation is informative.
    expect(fix.explanation).toContain("validation");
    expect(fix.explanation).toContain("guard");
  });

  it("preserves indentation from the original declaration", () => {
    const content = [
      `function outer() {`,
      `  function inner() {`,
      `    async function f() {`,
      `      const x = (await g())!;`,
      `      return x.y;`,
      `    }`,
      `    return f();`,
      `  }`,
      `  return inner();`,
      `}`,
    ].join("\n");
    const match = findNonNullAwaitPattern([{ path: "a.ts", content }], "null")!;
    const fix = applyNonNullAwaitTemplate({ path: "a.ts", content }, match);
    const lines = fix.content.split("\n");
    const guardLine = lines.find((l) => l.includes("if (!x)"));
    expect(guardLine).toBeDefined();
    expect(guardLine!.startsWith("      ")).toBe(true); // 6-space indent
  });
});

describe("tryDeterministicFix", () => {
  it("returns null when no match", () => {
    const result = tryDeterministicFix(
      [{ path: "a.ts", content: `const x = 1;` }],
      "null reference",
    );
    expect(result).toBeNull();
  });

  it("returns match+fix on the canonical pattern", () => {
    const content = [
      `async function f() {`,
      `  const x = (await g())!;`,
      `  return x.y;`,
      `}`,
    ].join("\n");
    const result = tryDeterministicFix(
      [{ path: "a.ts", content }],
      "TypeError: null",
    );
    expect(result).not.toBeNull();
    expect(result!.match.varName).toBe("x");
    expect(result!.fix.content).toContain("if (!x) throw");
  });
});
