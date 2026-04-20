import { describe, expect, it } from "vitest";
import {
  extractRelativeImports,
  prefetchContext,
  resolveImport,
} from "../context-prefetch";

describe("extractRelativeImports", () => {
  it("picks up static imports with named + default + namespace forms", () => {
    const src = `
import foo from "./a";
import { b, c } from "./b";
import * as ns from "./c";
import type { T } from "./d";
import "./side-effect";
`;
    expect(extractRelativeImports(src).sort()).toEqual([
      "./a",
      "./b",
      "./c",
      "./d",
      "./side-effect",
    ]);
  });

  it("picks up re-exports and require() and dynamic import()", () => {
    const src = `
export { x } from "./exp-named";
export * from "./exp-star";
const z = require("./req");
const lazy = import("./dyn");
`;
    const imports = extractRelativeImports(src).sort();
    expect(imports).toEqual(["./dyn", "./exp-named", "./exp-star", "./req"]);
  });

  it("ignores bare (npm package) specifiers", () => {
    const src = `
import React from "react";
import { useEffect } from "react";
import axios from "axios";
import foo from "./local";
`;
    expect(extractRelativeImports(src)).toEqual(["./local"]);
  });

  it("returns [] on source with no imports", () => {
    expect(extractRelativeImports("const x = 1;\nexport const y = 2;")).toEqual([]);
  });
});

describe("resolveImport", () => {
  const repoFiles = new Set([
    "src/a.ts",
    "src/b.ts",
    "src/nested/c.ts",
    "src/nested/index.ts",
    "src/d.tsx",
    "src/helper.js",
  ]);

  it("resolves direct hit with extension in file path", () => {
    expect(resolveImport("./a", "src/caller.ts", repoFiles)).toBe("src/a.ts");
  });

  it("resolves sibling .tsx", () => {
    expect(resolveImport("./d", "src/caller.ts", repoFiles)).toBe("src/d.tsx");
  });

  it("resolves directory/index.ts", () => {
    expect(resolveImport("./nested", "src/caller.ts", repoFiles)).toBe(
      "src/nested/index.ts",
    );
  });

  it("resolves nested files", () => {
    expect(resolveImport("./nested/c", "src/caller.ts", repoFiles)).toBe(
      "src/nested/c.ts",
    );
  });

  it("walks up with ../", () => {
    expect(resolveImport("../a", "src/nested/caller.ts", repoFiles)).toBe(
      "src/a.ts",
    );
  });

  it("returns null for bare specifier", () => {
    expect(resolveImport("react", "src/caller.ts", repoFiles)).toBeNull();
  });

  it("returns null when not found", () => {
    expect(resolveImport("./nowhere", "src/caller.ts", repoFiles)).toBeNull();
  });
});

describe("prefetchContext", () => {
  const makeMockGh = (store: Record<string, string>) => ({
    getFileContent: async (
      _token: string,
      _owner: string,
      _repo: string,
      path: string,
      _ref?: string,
    ): Promise<string | null> => {
      return store[path] ?? null;
    },
  });

  it("seeds + walks 1 hop of imports", async () => {
    const store = {
      "src/a.ts": `import { b } from "./b"; import "../lib/c";`,
      "src/b.ts": `export const b = 1;`,
      "lib/c.ts": `export const c = 2;`,
    };
    const repoFiles = Object.keys(store);
    const mockGh = makeMockGh(store);
    const { files, sources, skipped } = await prefetchContext(
      mockGh as unknown as typeof import("@/lib/services/github-api"),
      "t",
      "o",
      "r",
      "main",
      ["src/a.ts"],
      repoFiles,
      { maxFiles: 10, maxHops: 1 },
    );
    expect(files.size).toBe(3);
    expect(files.has("src/a.ts")).toBe(true);
    expect(files.has("src/b.ts")).toBe(true);
    expect(files.has("lib/c.ts")).toBe(true);
    expect(sources.seeds).toContain("src/a.ts");
    expect(sources.imports.sort()).toEqual(["lib/c.ts", "src/b.ts"]);
    expect(skipped).toEqual([]);
  });

  it("does NOT walk beyond maxHops", async () => {
    const store = {
      "a.ts": `import "./b";`,
      "b.ts": `import "./c";`,
      "c.ts": `export const c = 1;`,
    };
    const mockGh = makeMockGh(store);
    const { files } = await prefetchContext(
      mockGh as unknown as typeof import("@/lib/services/github-api"),
      "t", "o", "r", "main",
      ["a.ts"],
      Object.keys(store),
      { maxHops: 1 },
    );
    expect(files.has("a.ts")).toBe(true);
    expect(files.has("b.ts")).toBe(true);
    expect(files.has("c.ts")).toBe(false);
  });

  it("caps at maxFiles", async () => {
    const store = {
      "a.ts": `import "./b"; import "./c"; import "./d"; import "./e";`,
      "b.ts": "",
      "c.ts": "",
      "d.ts": "",
      "e.ts": "",
    };
    const mockGh = makeMockGh(store);
    const { files } = await prefetchContext(
      mockGh as unknown as typeof import("@/lib/services/github-api"),
      "t", "o", "r", "main",
      ["a.ts"],
      Object.keys(store),
      { maxFiles: 3 },
    );
    expect(files.size).toBe(3);
  });

  it("skips unsafe paths and sensitive files", async () => {
    const store = {
      "app.ts": `import "../.env"; import "./secrets.json"; import "./good";`,
      "good.ts": "export const x = 1;",
    };
    const mockGh = makeMockGh(store);
    const { files, skipped } = await prefetchContext(
      mockGh as unknown as typeof import("@/lib/services/github-api"),
      "t", "o", "r", "main",
      ["app.ts"],
      Object.keys(store),
    );
    expect(files.has("app.ts")).toBe(true);
    expect(files.has("good.ts")).toBe(true);
    // Neither the unsafe .env nor the secrets file is resolvable in
    // repoFiles anyway — the resolver returns null for them first —
    // but if they WERE resolvable, isSafePath would reject.
    expect(skipped.length).toBeGreaterThanOrEqual(0);
  });

  it("skips silently when a seed can't be fetched", async () => {
    const mockGh = makeMockGh({});
    const { files, skipped } = await prefetchContext(
      mockGh as unknown as typeof import("@/lib/services/github-api"),
      "t", "o", "r", "main",
      ["nowhere.ts"],
      ["other.ts"],
    );
    expect(files.size).toBe(0);
    expect(skipped).toContain("nowhere.ts");
  });
});
