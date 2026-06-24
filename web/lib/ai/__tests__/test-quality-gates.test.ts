import { describe, it, expect } from "vitest";
import { runQualityGates, extractExportNames } from "../test-quality-gates";

const goodTestFile = `import { describe, it, expect } from "vitest";
import { validateToken, hashPassword } from "../auth";

describe("validateToken", () => {
  it("returns user when token is valid", async () => {
    const result = await validateToken("valid-token");
    expect(result).toEqual({ id: 1, name: "alice" });
  });

  it("returns null when token is expired", async () => {
    const result = await validateToken("expired-token");
    expect(result).toBeNull();
  });
});

describe("hashPassword", () => {
  it("produces a different hash each call (salted)", async () => {
    const a = await hashPassword("password");
    const b = await hashPassword("password");
    expect(a).not.toBe(b);
  });
});
`;

const sourceContent = `export async function validateToken(token: string) {
  return null;
}
export async function hashPassword(pw: string) {
  return "";
}
`;

describe("runQualityGates", () => {
  it("approves a well-formed test file", () => {
    const result = runQualityGates({
      testFile: { path: "tests/auth.test.ts", content: goodTestFile },
      sourceContent,
    });
    expect(result.approved).toBe(true);
    expect(result.failed).toEqual([]);
    expect(result.passed.length).toBeGreaterThan(3);
  });

  it("rejects file with no it()/test() blocks", () => {
    const empty = `import { foo } from "../foo";\nconst x = 1;\n`;
    const result = runQualityGates({ testFile: { path: "a.test.ts", content: empty } });
    expect(result.approved).toBe(false);
    expect(result.failed.some((f) => f.includes("No it()/test()"))).toBe(true);
  });

  it("rejects test block with no assertion", () => {
    const bad = `import { foo } from "../foo";
describe("foo", () => {
  it("does the thing", () => {
    foo();
  });
});`;
    const result = runQualityGates({ testFile: { path: "a.test.ts", content: bad } });
    expect(result.approved).toBe(false);
    expect(result.failed.some((f) => f.includes("no assertion"))).toBe(true);
  });

  it("rejects trivial assertion expect(true).toBe(true)", () => {
    const trivial = `import { foo } from "../foo";
describe("foo", () => {
  it("works", () => {
    expect(true).toBe(true);
  });
});`;
    const result = runQualityGates({ testFile: { path: "a.test.ts", content: trivial } });
    expect(result.approved).toBe(false);
    expect(result.failed.some((f) => f.includes("trivial"))).toBe(true);
  });

  it("rejects hardcoded waitForTimeout", () => {
    const flaky = `import { test, expect } from "@playwright/test";
test("checkout flow", async ({ page }) => {
  await page.goto("/checkout");
  await page.waitForTimeout(2000);
  expect(await page.locator("h1").textContent()).toContain("Done");
});`;
    const result = runQualityGates({ testFile: { path: "e2e.test.ts", content: flaky } });
    expect(result.approved).toBe(false);
    expect(result.failed.some((f) => f.includes("Hardcoded wait"))).toBe(true);
  });

  it("rejects sleep() / new Promise(setTimeout)", () => {
    const lazy = `import { describe, it, expect } from "vitest";
describe("x", () => {
  it("waits a bit", async () => {
    await new Promise(r => setTimeout(r, 500));
    expect(1).toBe(1); // trivial too, but the sleep is what we're testing
  });
});`;
    const result = runQualityGates({ testFile: { path: "a.test.ts", content: lazy } });
    expect(result.approved).toBe(false);
    expect(result.failed.some((f) => f.toLowerCase().includes("hardcoded wait") || f.toLowerCase().includes("trivial"))).toBe(true);
  });

  it("rejects implementation-style test names", () => {
    const impl = `import { describe, it, expect } from "vitest";
import { validateToken } from "../auth";
describe("validateToken", () => {
  it("calls fetchUser internally", () => {
    expect(validateToken("x")).toBeDefined();
  });
});`;
    const result = runQualityGates({ testFile: { path: "a.test.ts", content: impl } });
    expect(result.approved).toBe(false);
    expect(result.failed.some((f) => f.includes("implementation"))).toBe(true);
  });

  it("rejects file exceeding 500 lines", () => {
    const bloated = `import { describe, it, expect } from "vitest";\n` +
      Array.from({ length: 510 }, (_, i) => `// line ${i}`).join("\n");
    const result = runQualityGates({ testFile: { path: "a.test.ts", content: bloated } });
    expect(result.approved).toBe(false);
    expect(result.failed.some((f) => f.includes("exceeds"))).toBe(true);
  });

  it("rejects test file that doesn't reference any source export", () => {
    const orphan = `import { describe, it, expect } from "vitest";
describe("unrelated", () => {
  it("does math", () => {
    expect(1 + 1).toBe(2);
  });
});`;
    const result = runQualityGates({
      testFile: { path: "a.test.ts", content: orphan },
      sourceContent: `export function validateToken() { return null; }`,
    });
    expect(result.approved).toBe(false);
    expect(result.failed.some((f) => f.includes("references none of the source"))).toBe(true);
  });

  it("approves Playwright test using waitFor (event-based)", () => {
    const e2e = `import { test, expect } from "@playwright/test";
test("login flow", async ({ page }) => {
  await page.goto("/login");
  await page.locator("#email").fill("user@x.com");
  await page.locator("#submit").click();
  await page.waitForURL("**/dashboard");
  await expect(page.locator("h1")).toContainText("Welcome");
});`;
    const result = runQualityGates({ testFile: { path: "e2e.test.ts", content: e2e } });
    expect(result.approved).toBe(true);
  });
});

describe("extractExportNames", () => {
  it("extracts named function exports", () => {
    const src = `export function foo() {}\nexport async function bar() {}\n`;
    expect(extractExportNames(src).sort()).toEqual(["bar", "foo"]);
  });

  it("extracts const/let/var exports", () => {
    const src = `export const FOO = 1;\nexport let bar = 2;\nexport var baz = 3;\n`;
    expect(extractExportNames(src).sort()).toEqual(["FOO", "bar", "baz"]);
  });

  it("extracts class exports", () => {
    const src = `export class UserService {}\n`;
    expect(extractExportNames(src)).toEqual(["UserService"]);
  });

  it("extracts default function export", () => {
    const src = `export default function handler() {}\n`;
    expect(extractExportNames(src)).toEqual(["handler"]);
  });

  it("extracts brace exports with aliases", () => {
    const src = `function a() {} function b() {} export { a, b as renamed };\n`;
    const names = extractExportNames(src).sort();
    expect(names).toContain("a");
    expect(names).toContain("b");
  });

  it("returns empty for files with no exports", () => {
    const src = `const x = 1; function y() {}`;
    expect(extractExportNames(src)).toEqual([]);
  });
});
