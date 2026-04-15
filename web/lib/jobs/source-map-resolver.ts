/**
 * Pure source-map resolver. Takes a parsed source map (raw JSON or text)
 * + a list of stack frames, returns a NEW list with `mapped` populated
 * for any frame the map could resolve.
 *
 * Why a wrapper around `source-map`:
 *   - That lib's API is async (consumer.with) and easy to leak handles
 *     on. We centralise lifecycle here.
 *   - Frames whose URL doesn't match this map are passed through unchanged
 *     so callers can pipe many maps through without filtering manually.
 *   - Errors (bad map, mid-string parse fail) NEVER throw — the worst
 *     case is "frame unchanged", which is what `Phase I.c` already shows.
 */

// `source-map-js` is the pure-JS fork (used by webpack/svelte). API is
// the synchronous-pre-0.7 surface — no WASM init dance, works the same
// in Node + edge runtimes.
import { SourceMapConsumer, type RawSourceMap } from "source-map-js";
import type { StackFrame } from "./replay-stack-parser";

/**
 * Resolve a single frame against a consumer that's already been opened
 * for the source URL. Returns the same frame (with `mapped` populated)
 * or the input unchanged when the consumer can't map it.
 */
function resolveFrame(frame: StackFrame, consumer: SourceMapConsumer): StackFrame {
  if (frame.col == null) return frame; // need column for accurate mapping
  try {
    const pos = consumer.originalPositionFor({
      line: frame.line,
      column: frame.col,
    });
    if (!pos.source || pos.line == null) return frame;
    return {
      ...frame,
      mapped: {
        file: pos.source,
        line: pos.line,
        col: typeof pos.column === "number" ? pos.column : null,
        fnName: pos.name ?? frame.fnName ?? null,
      },
    };
  } catch {
    return frame;
  }
}

/**
 * Apply ONE source map (passed as raw text or pre-parsed JSON) to every
 * frame in `frames` whose source URL matches `mapForUrl`. Frames from
 * other URLs pass through unchanged.
 *
 * Returns a brand-new array — never mutates input.
 */
export async function applySourceMap(opts: {
  mapForUrl: string;
  rawMap: string | RawSourceMap;
  frames: StackFrame[];
}): Promise<StackFrame[]> {
  const { mapForUrl, rawMap, frames } = opts;
  const matching = frames.some((f) => !f.mapped && f.source === mapForUrl);
  if (!matching) return frames;

  // source-map-js consumer is sync (no WASM). We wrap parse + map in a
  // try/catch so a malformed .map never blows up the whole resolver.
  let json: RawSourceMap;
  try {
    json = typeof rawMap === "string" ? (JSON.parse(rawMap) as RawSourceMap) : rawMap;
  } catch {
    return frames;
  }
  try {
    const consumer = new SourceMapConsumer(json);
    return frames.map((f) =>
      f.mapped || f.source !== mapForUrl ? f : resolveFrame(f, consumer),
    );
  } catch {
    return frames;
  }
}

/**
 * Apply MANY maps to MANY frames in one pass. Used by the analyzer once
 * the fetcher has resolved each unique source URL to a (maybe-null) map.
 *
 * Bounded by the URL count, not by frames × maps — the inner loop short-
 * circuits via the `source` match in `applySourceMap`.
 */
export async function applyAllMaps(
  frames: StackFrame[],
  mapsByUrl: Map<string, string | RawSourceMap | null>,
): Promise<StackFrame[]> {
  let current = frames;
  for (const [url, raw] of mapsByUrl) {
    if (raw == null) continue;
    current = await applySourceMap({ mapForUrl: url, rawMap: raw, frames: current });
  }
  return current;
}
