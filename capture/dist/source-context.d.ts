/**
 * Source snippets + git blame for stack frames (Track A piece 4).
 *
 * For every frame in the error stack, this reads the surrounding source
 * (10 lines before, the offending line, 10 lines after) and runs `git blame`
 * per line so the AI sees who last touched the code and when.
 *
 * Zero deps — uses `node:fs`, `node:path`, `node:child_process` only.
 *
 * Performance:
 *   - File reads cached by `(absPath, mtimeMs)` for the lifetime of the process.
 *   - Blame results cached by `(absPath, line, file_mtimeMs, head_sha)` —
 *     blame doesn't change unless the file or HEAD does.
 *   - All git invocations use `spawnSync` with a 500ms timeout. Slow repos
 *     simply skip blame instead of stalling the error path.
 *
 * Skip rules:
 *   - Browser builds: this module is Node-only. The dynamic import in
 *     `client.ts` swallows the error.
 *   - Node_modules: blame is skipped for any path containing `/node_modules/`.
 *   - Outside repo: if the file isn't tracked by git, blame is silently dropped.
 *   - Stack frame with `<unknown>` file or non-positive line: skipped.
 */
import type { SourceContextFrame } from "./types.js";
/**
 * Build per-frame source context for the given stack. Returns one entry per
 * frame that resolved to a readable file. Frames that can't be resolved
 * (synthetic, minified without sources, third-party JIT) are skipped — the
 * caller can still render the original text stack.
 */
export declare function getSourceContext(stack: string): SourceContextFrame[];
/** Test-only: drop all caches so unit tests can re-exercise the lookup paths. */
export declare function __resetSourceContextCachesForTesting(): void;
//# sourceMappingURL=source-context.d.ts.map