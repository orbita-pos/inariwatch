// Phase 2.3 — language detection unit tests.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bucketFilesByLanguage,
  detectLanguageFromPath,
  detectLanguagesPresent,
} from "../language-detect";

describe("detectLanguageFromPath", () => {
  it.each([
    ["src/index.ts", "typescript"],
    ["src/Component.tsx", "typescript"],
    ["src/foo.mts", "typescript"],
    ["src/bar.cts", "typescript"],
    ["scripts/build.js", "typescript"],
    ["scripts/build.jsx", "typescript"],
    ["scripts/build.mjs", "typescript"],
    ["scripts/build.cjs", "typescript"],
    ["app/main.py", "python"],
    ["app/__init__.py", "python"],
    ["README.md", "unknown"],
    ["src/file.go", "unknown"],
    ["src/file.rs", "unknown"],
    ["", "unknown"],
  ])("%s → %s", (input, expected) => {
    expect(detectLanguageFromPath(input)).toBe(expected);
  });

  it("matches case-insensitively", () => {
    expect(detectLanguageFromPath("SRC/Foo.PY")).toBe("python");
    expect(detectLanguageFromPath("Src/Foo.TS")).toBe("typescript");
  });
});

describe("bucketFilesByLanguage", () => {
  it("groups by language", () => {
    const out = bucketFilesByLanguage([
      "src/a.ts",
      "src/b.tsx",
      "app/c.py",
      "README.md",
      "scripts/d.js",
    ]);
    expect(out.typescript).toEqual(["src/a.ts", "src/b.tsx", "scripts/d.js"]);
    expect(out.python).toEqual(["app/c.py"]);
    expect(out.unknown).toEqual(["README.md"]);
  });

  it("handles empty input", () => {
    const out = bucketFilesByLanguage([]);
    expect(out.typescript).toEqual([]);
    expect(out.python).toEqual([]);
    expect(out.unknown).toEqual([]);
  });
});

describe("detectLanguagesPresent", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "v2-detect-"));
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  function makeRepo(name: string, files: Record<string, string>): string {
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return dir;
  }

  it("detects only typescript when only .ts present", () => {
    const dir = makeRepo("ts-only", {
      "src/a.ts": "",
      "src/b.tsx": "",
    });
    const found = detectLanguagesPresent(dir);
    expect(found.has("typescript")).toBe(true);
    expect(found.has("python")).toBe(false);
  });

  it("detects only python when only .py present", () => {
    const dir = makeRepo("py-only", {
      "app/main.py": "",
    });
    const found = detectLanguagesPresent(dir);
    expect(found.has("python")).toBe(true);
    expect(found.has("typescript")).toBe(false);
  });

  it("detects both in a mixed repo", () => {
    const dir = makeRepo("mixed", {
      "frontend/src/index.ts": "",
      "backend/app/main.py": "",
    });
    const found = detectLanguagesPresent(dir);
    expect(found.has("typescript")).toBe(true);
    expect(found.has("python")).toBe(true);
  });

  it("skips node_modules / __pycache__ / .venv", () => {
    const dir = makeRepo("with-skip-dirs", {
      "node_modules/foo/bar.ts": "",
      "__pycache__/foo.cpython-310.pyc.py": "",
      ".venv/lib/python3.11/site-packages/foo.py": "",
      "src/real.ts": "",
    });
    const found = detectLanguagesPresent(dir);
    expect(found.has("typescript")).toBe(true);
    expect(found.has("python")).toBe(false);
  });

  it("returns empty set for an empty repo", () => {
    const dir = makeRepo("empty", { "README.md": "" });
    const found = detectLanguagesPresent(dir);
    expect(found.size).toBe(0);
  });

  it("returns empty set for a missing path", () => {
    const found = detectLanguagesPresent(path.join(tmpDir, "does-not-exist"));
    expect(found.size).toBe(0);
  });
});
