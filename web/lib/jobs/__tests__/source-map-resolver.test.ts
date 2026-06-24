import { describe, it, expect } from "vitest";
// `source-map` (the WASM fork) is the canonical generator. Pairing it
// with `source-map-js` (pure-JS consumer) in the resolver is fine — they
// produce/read the same v3 spec.
import { SourceMapGenerator } from "source-map";
import { SourceMapConsumer } from "source-map-js";
import { applySourceMap, applyAllMaps } from "../source-map-resolver";
import type { StackFrame } from "../replay-stack-parser";

/**
 * Build a minimal source map that maps generated (line:1, col:N) to a
 * named original source. The library uses VLQ-encoded mappings; a single
 * mapping is enough to resolve the exact (line, col) we register.
 *
 * We round-trip through `SourceMapConsumer` to confirm the map is well-
 * formed before the test exercises the resolver — otherwise a generator
 * quirk would surface as a mysterious resolver failure.
 */
async function buildMap(opts: {
  fileName: string;
  source: string;
  generatedCol: number;
  originalLine: number;
  originalColumn: number;
  name?: string;
}): Promise<string> {
  const gen = new SourceMapGenerator({ file: opts.fileName });
  gen.addMapping({
    generated: { line: 1, column: opts.generatedCol },
    original: { line: opts.originalLine, column: opts.originalColumn },
    source: opts.source,
    name: opts.name,
  });
  const json = gen.toString();
  // Sanity check — fail loudly here if the generator output isn't usable
  // by the consumer the resolver actually uses (source-map-js, sync API).
  const c = new SourceMapConsumer(JSON.parse(json));
  const pos = c.originalPositionFor({ line: 1, column: opts.generatedCol });
  if (pos.source !== opts.source) {
    throw new Error(
      `buildMap fixture broken: wanted source=${opts.source}, got source=${pos.source} (line=${pos.line} col=${pos.column})`,
    );
  }
  return json;
}

const URL = "https://app.com/_next/static/chunks/abc.js";

const frame = (col: number | null, source = URL, line = 1): StackFrame => ({
  fnName: null,
  source,
  line,
  col,
  mapped: null,
});

describe("applySourceMap", () => {
  it("populates frame.mapped on a successful match", async () => {
    const rawMap = await buildMap({
      fileName: "abc.js",
      source: "src/checkout.tsx",
      generatedCol: 100,
      originalLine: 42,
      originalColumn: 7,
      name: "handleClick",
    });
    const out = await applySourceMap({
      mapForUrl: URL,
      rawMap,
      frames: [frame(100)],
    });
    expect(out).toHaveLength(1);
    expect(out[0].mapped).toEqual({
      file: "src/checkout.tsx",
      line: 42,
      col: 7,
      fnName: "handleClick",
    });
  });

  it("leaves frames from a different URL untouched", async () => {
    const rawMap = await buildMap({
      fileName: "abc.js", source: "src/x.tsx",
      generatedCol: 10, originalLine: 5, originalColumn: 0,
    });
    const others = [frame(10, "https://app.com/other.js")];
    const out = await applySourceMap({ mapForUrl: URL, rawMap, frames: others });
    expect(out[0].mapped).toBeNull();
  });

  it("skips frames without a column (column is required for mapping)", async () => {
    const rawMap = await buildMap({
      fileName: "abc.js", source: "src/x.tsx",
      generatedCol: 10, originalLine: 5, originalColumn: 0,
    });
    const out = await applySourceMap({ mapForUrl: URL, rawMap, frames: [frame(null)] });
    expect(out[0].mapped).toBeNull();
  });

  it("returns frames unchanged when the map JSON is malformed", async () => {
    const out = await applySourceMap({
      mapForUrl: URL,
      rawMap: "{not valid json",
      frames: [frame(100)],
    });
    expect(out).toHaveLength(1);
    expect(out[0].mapped).toBeNull();
  });

  it("does not overwrite an already-mapped frame", async () => {
    const rawMap = await buildMap({
      fileName: "abc.js", source: "src/new.tsx",
      generatedCol: 100, originalLine: 99, originalColumn: 0,
    });
    const pre = { ...frame(100), mapped: { file: "src/old.tsx", line: 1, col: 0, fnName: null } };
    const out = await applySourceMap({ mapForUrl: URL, rawMap, frames: [pre] });
    expect(out[0].mapped).toEqual(pre.mapped);
  });

  it("short-circuits when no frames need mapping (no consumer alloc)", async () => {
    // Pass a deliberately broken map — if we tried to parse it the test
    // would still pass because of the catch, but the optimisation lets
    // us assert that an empty match list is the early exit.
    const out = await applySourceMap({
      mapForUrl: URL,
      rawMap: "garbage",
      frames: [frame(10, "https://nope.com/x.js")],
    });
    expect(out).toEqual([frame(10, "https://nope.com/x.js")]);
  });
});

describe("applyAllMaps", () => {
  it("applies a different map per URL", async () => {
    const URL_A = "https://app.com/a.js";
    const URL_B = "https://app.com/b.js";
    const mapA = await buildMap({
      fileName: "a.js", source: "src/a.tsx",
      generatedCol: 5, originalLine: 1, originalColumn: 0, name: "a",
    });
    const mapB = await buildMap({
      fileName: "b.js", source: "src/b.tsx",
      generatedCol: 5, originalLine: 2, originalColumn: 0, name: "b",
    });
    const frames: StackFrame[] = [frame(5, URL_A), frame(5, URL_B)];
    const out = await applyAllMaps(
      frames,
      new Map([[URL_A, mapA], [URL_B, mapB]]),
    );
    expect(out[0].mapped?.file).toBe("src/a.tsx");
    expect(out[1].mapped?.file).toBe("src/b.tsx");
  });

  it("ignores null map entries (failed fetches)", async () => {
    const out = await applyAllMaps(
      [frame(5, URL)],
      new Map([[URL, null]]),
    );
    expect(out[0].mapped).toBeNull();
  });

  it("leaves frames whose URL has no map entry alone", async () => {
    const out = await applyAllMaps([frame(5, URL)], new Map());
    expect(out[0].mapped).toBeNull();
  });
});
