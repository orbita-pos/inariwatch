// Phase 2.1 smoke test — locks in the integration mode decision.
//
// Asserts that pyright-langserver 1.1.380:
//   1. Spawns and completes the LSP handshake
//   2. Advertises the capabilities we depend on
//   3. Returns documentSymbol entries for a 5-line file
//   4. Returns a typed hover for `add`
//   5. Returns 2 reference locations for `add` (declaration + 1 call site)
//   6. Shuts down cleanly
//
// If any of these break on a pyright bump, this test fails and you re-pin
// (or update the extractor's expectations) BEFORE Phase 2.2 starts touching
// real fixtures. That's the contract this test enforces.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import {
  PyrightLspClient,
  pathToFileUri,
  fileUriToPath,
  resolveLangserverPath,
  type DocumentSymbol,
  type SymbolInformation,
} from "../lsp.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "fixtures", "probe", "hello.py");
const fixtureUri = pathToFileUri(fixturePath);
const fixtureText = readFileSync(fixturePath, "utf8");

// LSP SymbolKind enum values per the spec.
const KIND_FUNCTION = 12;
const KIND_VARIABLE = 13;
const KIND_CLASS = 5;
const KIND_METHOD = 6;
const KIND_PROPERTY = 7;

describe("PyrightLspClient — Phase 2.1 integration mode lock", () => {
  let client: PyrightLspClient;

  beforeAll(async () => {
    client = new PyrightLspClient({ rootUri: pathToFileUri(here) });
    await client.start();
    client.didOpen(fixtureUri, "python", fixtureText);
    // pyright analyzes async on the worker thread; give it room before
    // the first request. ~700ms is generous on a cold-start Windows box.
    await new Promise((r) => setTimeout(r, 700));
  }, 30_000);

  afterAll(async () => {
    if (client) await client.stop();
  });

  it("resolves pyright-langserver via require.resolve", () => {
    const path = resolveLangserverPath();
    expect(path).toMatch(/pyright-langserver\.js$/);
  });

  it("URI helpers round-trip Windows + POSIX paths", () => {
    expect(pathToFileUri("C:\\Users\\foo\\bar.py")).toBe("file:///c%3A/Users/foo/bar.py");
    expect(fileUriToPath("file:///c%3A/Users/foo/bar.py")).toBe("C:/Users/foo/bar.py");
    expect(pathToFileUri("/usr/local/foo.py")).toBe("file:///usr/local/foo.py");
    expect(fileUriToPath("file:///usr/local/foo.py")).toBe("/usr/local/foo.py");
  });

  it("returns documentSymbol entries with kind / range / containerName", async () => {
    const symbols = await client.documentSymbol(fixtureUri);
    expect(symbols.length).toBeGreaterThanOrEqual(4);
    // Pyright returns the flat (SymbolInformation) shape with `containerName`.
    const flat = symbols as SymbolInformation[];
    const names = flat.map((s) => s.name);
    expect(names).toContain("add");
    expect(names).toContain("Greeter");
    expect(names).toContain("__init__");
    expect(names).toContain("greet");

    const add = flat.find((s) => s.name === "add" && s.containerName == null);
    expect(add).toBeDefined();
    expect(add!.kind).toBe(KIND_FUNCTION);
    expect(add!.location.uri).toBe(fixtureUri);
    expect(add!.location.range.start.line).toBe(0);

    const greeter = flat.find((s) => s.name === "Greeter");
    expect(greeter).toBeDefined();
    expect(greeter!.kind).toBe(KIND_CLASS);

    const greet = flat.find((s) => s.name === "greet");
    expect(greet).toBeDefined();
    expect(greet!.kind).toBe(KIND_METHOD);
    expect(greet!.containerName).toBe("Greeter");

    // Confirm we can also tell the LSP the doc is a hierarchical-doc-symbol
    // server and we'd get DocumentSymbol back. Pyright uses SymbolInformation
    // even when the client claims hierarchical support — that's a known
    // quirk and the extractor (Phase 2.2) walks it via `containerName`.
    if (isDocumentSymbolShape(symbols[0]!)) {
      // Defensive — should not fire today, but if pyright switches we want
      // to know so we can update the extractor.
      throw new Error("pyright unexpectedly returned hierarchical DocumentSymbol shape");
    }
  });

  it("returns typed hover for `add`", async () => {
    const hover = await client.hover(fixtureUri, { line: 0, character: 4 });
    expect(hover).not.toBeNull();
    const text = renderHoverText(hover!);
    // Pyright's hover format for a function:
    //   "(function) def add(\n    a: int,\n    b: int\n) -> int"
    expect(text).toMatch(/\(function\)/);
    expect(text).toMatch(/def add/);
    expect(text).toMatch(/-> int/);
    expect(text).toMatch(/a: int/);
    expect(text).toMatch(/b: int/);
  });

  it("returns references for `add` — declaration + call site", async () => {
    const refs = await client.references(
      fixtureUri,
      { line: 0, character: 4 },
      true,
    );
    expect(refs.length).toBeGreaterThanOrEqual(2);
    // The fixture calls `add(1, 2)` on line 12 (0-indexed).
    const callSite = refs.find((r) => r.range.start.line === 12);
    expect(callSite).toBeDefined();
    expect(callSite!.uri).toBe(fixtureUri);
  });

  it("returns hover for `Greeter.greet` with class context", async () => {
    // Line 8 col 8 = 'g' of 'greet'. Char positions are 0-based per LSP.
    const hover = await client.hover(fixtureUri, { line: 8, character: 8 });
    expect(hover).not.toBeNull();
    const text = renderHoverText(hover!);
    expect(text).toMatch(/(method|function)/);
    expect(text).toMatch(/greet/);
    // Pyright includes the return type in the hover.
    expect(text).toMatch(/-> str/);
  });

  it("captures server-side window/logMessage notifications", () => {
    const logs = client.getLogs();
    // Pyright emits a handful of info messages on startup ("Pyright X.Y.Z",
    // "Setting pythonPath...", etc). At least ONE should be captured.
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });
});

function renderHoverText(h: { contents: unknown }): string {
  const c = h.contents as
    | string
    | { kind?: string; value?: string }
    | Array<string | { value?: string }>;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((x) => (typeof x === "string" ? x : x?.value ?? ""))
      .join("\n");
  }
  if (c && typeof c === "object" && "value" in c) return c.value ?? "";
  return JSON.stringify(c);
}

function isDocumentSymbolShape(
  s: SymbolInformation | DocumentSymbol,
): s is DocumentSymbol {
  return "selectionRange" in s && (s as DocumentSymbol).selectionRange != null;
}
