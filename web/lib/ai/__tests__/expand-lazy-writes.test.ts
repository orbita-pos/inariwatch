import { describe, it, expect } from "vitest";
import { expandLazyWrites, expandFixFiles, LazyWriteExpansionError, KEEP_MARKER_RE } from "../expand-lazy-writes";

// ── Test fixtures ──────────────────────────────────────────────────────────

const ORIGINAL = [
  'import { db } from "./db"',
  'import { eq, ilike } from "drizzle-orm"',
  'import { users } from "./schema"',
  "",
  "export async function getUser(id: string) {",
  "  const [user] = await db",
  "    .select()",
  "    .from(users)",
  '    .where(eq(users.id, id))',
  "  return user",
  "}",
  "",
  "export async function searchUsers(query: string) {",
  "  const results = await db",
  "    .select()",
  "    .from(users)",
  '    .where(ilike(users.name, `%${query}%`))',
  "  return results",
  "}",
].join("\n");

// ── KEEP_MARKER_RE ─────────────────────────────────────────────────────────

describe("KEEP_MARKER_RE", () => {
  it("matches JS-style markers", () => {
    expect(KEEP_MARKER_RE.test("// ... keep existing code ...")).toBe(true);
    expect(KEEP_MARKER_RE.test("  // ... keep existing code ...")).toBe(true);
    expect(KEEP_MARKER_RE.test("// ...keep existing code...")).toBe(true);
    expect(KEEP_MARKER_RE.test("// ... keep existing code ...")).toBe(true);
  });

  it("matches Python-style markers", () => {
    expect(KEEP_MARKER_RE.test("# ... keep existing code ...")).toBe(true);
    expect(KEEP_MARKER_RE.test("  # ... keep existing code ...")).toBe(true);
  });

  it("matches block comment markers", () => {
    expect(KEEP_MARKER_RE.test("/* ... keep existing code ... */")).toBe(true);
    expect(KEEP_MARKER_RE.test("{/* ... keep existing code ... */}")).toBe(true);
  });

  it("does not match regular code", () => {
    expect(KEEP_MARKER_RE.test("const x = 1")).toBe(false);
    expect(KEEP_MARKER_RE.test("// this is a normal comment")).toBe(false);
    expect(KEEP_MARKER_RE.test("// keep this code")).toBe(false);
  });
});

// ── expandLazyWrites ───────────────────────────────────────────────────────

describe("expandLazyWrites", () => {
  it("returns content unchanged when no markers present", () => {
    const content = 'const x = 1\nconst y = 2\nreturn x + y';
    expect(expandLazyWrites(content, ORIGINAL)).toBe(content);
  });

  it("expands a single marker in the middle", () => {
    const aiOutput = [
      'import { db } from "./db"',
      'import { eq, ilike } from "drizzle-orm"',
      'import { users } from "./schema"',
      "",
      "export async function getUser(id: string) {",
      "  const [user] = await db",
      "    .select()",
      "    .from(users)",
      '    .where(eq(users.id, id))',
      "  if (!user) return null",  // <-- the fix: added null check
      "  return user",
      "}",
      "",
      "// ... keep existing code ...",
    ].join("\n");

    const expanded = expandLazyWrites(aiOutput, ORIGINAL);
    const lines = expanded.split("\n");

    // Should contain the fix
    expect(lines).toContain("  if (!user) return null");
    // Should contain the preserved searchUsers function
    expect(lines).toContain("export async function searchUsers(query: string) {");
    expect(lines).toContain('    .where(ilike(users.name, `%${query}%`))');
    expect(lines).toContain("  return results");
    expect(lines).toContain("}");
  });

  it("expands marker at the beginning", () => {
    const aiOutput = [
      "// ... keep existing code ...",
      "export async function searchUsers(query: string) {",
      "  const results = await db",
      "    .select()",
      "    .from(users)",
      '    .where(ilike(users.name, `%${query}%`))',
      "  return results.filter(Boolean)",  // <-- fix
      "}",
    ].join("\n");

    const expanded = expandLazyWrites(aiOutput, ORIGINAL);
    const lines = expanded.split("\n");

    // Should have the original imports and getUser preserved
    expect(lines).toContain('import { db } from "./db"');
    expect(lines).toContain("export async function getUser(id: string) {");
    expect(lines).toContain("  return user");
    // And the fix
    expect(lines).toContain("  return results.filter(Boolean)");
  });

  it("expands multiple markers", () => {
    const aiOutput = [
      "// ... keep existing code ...",
      "export async function getUser(id: string) {",
      "  const [user] = await db",
      "    .select()",
      "    .from(users)",
      '    .where(eq(users.id, id))',
      "  if (!user) throw new Error('not found')",  // fix 1
      "  return user",
      "}",
      "",
      "// ... keep existing code ...",
    ].join("\n");

    const expanded = expandLazyWrites(aiOutput, ORIGINAL);
    const lines = expanded.split("\n");

    // Imports preserved
    expect(lines).toContain('import { db } from "./db"');
    // Fix 1 present
    expect(lines).toContain("  if (!user) throw new Error('not found')");
    // searchUsers preserved via second marker
    expect(lines).toContain("export async function searchUsers(query: string) {");
  });

  it("throws LazyWriteExpansionError when anchor-before is not found", () => {
    const aiOutput = [
      "this line does not exist in original",
      "// ... keep existing code ...",
      "export async function searchUsers(query: string) {",
    ].join("\n");

    expect(() => expandLazyWrites(aiOutput, ORIGINAL)).toThrow(LazyWriteExpansionError);
    expect(() => expandLazyWrites(aiOutput, ORIGINAL)).toThrow(/Anchor before marker not found/);
  });

  it("throws LazyWriteExpansionError when anchor-after is not found", () => {
    const aiOutput = [
      'import { db } from "./db"',
      "// ... keep existing code ...",
      "function thisDoesNotExistInOriginal() {",
    ].join("\n");

    expect(() => expandLazyWrites(aiOutput, ORIGINAL)).toThrow(LazyWriteExpansionError);
    expect(() => expandLazyWrites(aiOutput, ORIGINAL)).toThrow(/Anchor after marker not found/);
  });

  it("handles marker at end of file (no anchor-after)", () => {
    const aiOutput = [
      'import { db } from "./db"',
      "// ... keep existing code ...",
    ].join("\n");

    const expanded = expandLazyWrites(aiOutput, ORIGINAL);
    const lines = expanded.split("\n");

    // Should have the import line and then everything from the original after it
    expect(lines[0]).toBe('import { db } from "./db"');
    expect(lines).toContain('import { eq, ilike } from "drizzle-orm"');
    expect(lines).toContain("}");
    // Last non-empty line should be closing brace of searchUsers
    const lastNonEmpty = lines.filter(l => l.trim()).pop();
    expect(lastNonEmpty).toBe("}");
  });

  it("handles Python-style markers", () => {
    const pyOriginal = [
      "import os",
      "import sys",
      "",
      "def hello():",
      '    print("hello")',
      "",
      "def goodbye():",
      '    print("bye")',
    ].join("\n");

    const aiOutput = [
      "# ... keep existing code ...",
      "def hello():",
      '    print("HELLO WORLD")',  // fix
      "",
      "# ... keep existing code ...",
    ].join("\n");

    const expanded = expandLazyWrites(aiOutput, pyOriginal);
    const lines = expanded.split("\n");

    expect(lines).toContain("import os");
    expect(lines).toContain('    print("HELLO WORLD")');
    expect(lines).toContain("def goodbye():");
  });

  it("preserves indentation exactly", () => {
    const original = [
      "function outer() {",
      "  function inner() {",
      "    const a = 1",
      "    const b = 2",
      "    return a + b",
      "  }",
      "  return inner()",
      "}",
    ].join("\n");

    const aiOutput = [
      "function outer() {",
      "  function inner() {",
      "    const a = 1",
      "    const b = 2",
      "    const c = 3",  // fix: added
      "    return a + b + c",  // fix: modified
      "  }",  // anchor — exists in original
      "// ... keep existing code ...",
    ].join("\n");

    const expanded = expandLazyWrites(aiOutput, original);
    const lines = expanded.split("\n");

    expect(lines).toContain("    const c = 3");
    expect(lines).toContain("    return a + b + c");
    expect(lines).toContain("  }");
    expect(lines).toContain("  return inner()");
    expect(lines).toContain("}");
  });
});

// ── expandFixFiles ─────────────────────────────────────────────────────────

describe("expandFixFiles", () => {
  it("passes through files without originals", () => {
    const files = [{ path: "new-file.ts", content: "const x = 1" }];
    const originals = new Map<string, string>();
    const result = expandFixFiles(files, originals);
    expect(result[0].content).toBe("const x = 1");
  });

  it("passes through files without markers", () => {
    const files = [{ path: "a.ts", content: "const x = 1\nconst y = 2" }];
    const originals = new Map([["a.ts", ORIGINAL]]);
    const result = expandFixFiles(files, originals);
    expect(result[0].content).toBe("const x = 1\nconst y = 2");
  });

  it("expands markers against originals", () => {
    const files = [{
      path: "a.ts",
      content: [
        '// ... keep existing code ...',
        'export async function searchUsers(query: string) {',
        '  return []',
        '}',
      ].join("\n"),
    }];
    const originals = new Map([["a.ts", ORIGINAL]]);
    const result = expandFixFiles(files, originals);

    expect(result[0].content).toContain('import { db } from "./db"');
    expect(result[0].content).toContain("  return []");
  });

  it("falls back to raw content on anchor mismatch instead of throwing", () => {
    const rawContent = [
      "line that does not exist",
      "// ... keep existing code ...",
      "another fake line",
    ].join("\n");
    const files = [{ path: "a.ts", content: rawContent }];
    const originals = new Map([["a.ts", ORIGINAL]]);

    const result = expandFixFiles(files, originals);
    expect(result[0].content).toBe(rawContent);
  });
});
