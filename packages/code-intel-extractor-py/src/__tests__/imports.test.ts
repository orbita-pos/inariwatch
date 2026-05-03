// Pure parser tests for the Python import extractor. No LSP. Fast.

import { describe, it, expect } from "vitest";

import { extractImports } from "../imports.js";

describe("extractImports", () => {
  it("parses bare imports", () => {
    const out = extractImports({
      source: "import os\nimport sys\n",
      filePath: "a.py",
      rootDir: "/tmp/repo",
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      sourceFile: "a.py",
      targetModule: "os",
      resolvedFile: null,
      importedNames: null,
    });
    expect(out[1]?.targetModule).toBe("sys");
  });

  it("parses import-as", () => {
    const out = extractImports({
      source: "import numpy as np\n",
      filePath: "a.py",
      rootDir: "/tmp/repo",
    });
    expect(out[0]).toMatchObject({
      targetModule: "numpy",
      importedNames: [{ local: "np", original: "numpy" }],
    });
  });

  it("parses dotted imports", () => {
    const out = extractImports({
      source: "import a.b.c\n",
      filePath: "x.py",
      rootDir: "/tmp/repo",
    });
    expect(out[0]?.targetModule).toBe("a.b.c");
  });

  it("parses comma-separated imports", () => {
    const out = extractImports({
      source: "import a, b as bb, c.d\n",
      filePath: "x.py",
      rootDir: "/tmp/repo",
    });
    expect(out).toHaveLength(3);
    expect(out[0]?.targetModule).toBe("a");
    expect(out[1]?.targetModule).toBe("b");
    expect(out[1]?.importedNames).toEqual([{ local: "bb", original: "b" }]);
    expect(out[2]?.targetModule).toBe("c.d");
  });

  it("parses from-import with names", () => {
    const out = extractImports({
      source: "from typing import Optional, Union as U\n",
      filePath: "x.py",
      rootDir: "/tmp/repo",
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.targetModule).toBe("typing");
    expect(out[0]?.importedNames).toEqual([
      "Optional",
      { local: "U", original: "Union" },
    ]);
  });

  it("handles parenthesized multi-line from-import", () => {
    const out = extractImports({
      source: "from foo import (\n    a,\n    b,\n    c as cc,\n)\n",
      filePath: "x.py",
      rootDir: "/tmp/repo",
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.importedNames).toEqual(["a", "b", { local: "cc", original: "c" }]);
  });

  it("handles relative imports with leading dots", () => {
    const out = extractImports({
      source: "from . import sibling\nfrom ..parent import shared\n",
      filePath: "pkg/sub/mod.py",
      rootDir: "/tmp/repo",
    });
    expect(out).toHaveLength(2);
    expect(out[0]?.targetModule).toBe(".");
    expect(out[1]?.targetModule).toBe("..parent");
  });

  it("captures star imports as a re-export sentinel", () => {
    const out = extractImports({
      source: "from foo import *\n",
      filePath: "x.py",
      rootDir: "/tmp/repo",
    });
    expect(out[0]?.importedNames).toEqual([{ local: "*", original: "*" }]);
  });

  it("ignores indented (function-local) imports", () => {
    const out = extractImports({
      source: "def f():\n    import inner_only\n",
      filePath: "x.py",
      rootDir: "/tmp/repo",
    });
    expect(out).toHaveLength(0);
  });

  it("ignores imports inside a string literal", () => {
    const out = extractImports({
      source: "x = \"import nothing\"\n",
      filePath: "x.py",
      rootDir: "/tmp/repo",
    });
    expect(out).toHaveLength(0);
  });

  it("strips trailing comments", () => {
    const out = extractImports({
      source: "import os  # noqa: F401\n",
      filePath: "x.py",
      rootDir: "/tmp/repo",
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.targetModule).toBe("os");
  });

  it("handles backslash-continued import lines", () => {
    const out = extractImports({
      source: "from foo \\\n    import bar\n",
      filePath: "x.py",
      rootDir: "/tmp/repo",
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.targetModule).toBe("foo");
    expect(out[0]?.importedNames).toEqual(["bar"]);
  });
});
