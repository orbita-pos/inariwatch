/**
 * TypeScript source — extracts shape from `interface`/`type` declarations
 * and function-parameter type annotations.
 *
 * Strategy: single-file AST walk via the TypeScript compiler API. We
 * intentionally do NOT build a `Program` (which would type-check the whole
 * world and take seconds) — extraction runs in the SDK hot-path on a user
 * machine, so we trade fidelity for cost. Cross-file imports degrade to
 * `$ref: "TypeName"` rather than failing.
 *
 * Peer dep: `typescript`. If absent, `canParse` returns `false` and the
 * source is silently skipped — same contract every other source follows.
 *
 * Resolution order for a frame `(file, symbol)`:
 *   1. find function/method declaration named `symbol` in `file`
 *   2. take its first parameter's type annotation
 *   3. resolve that type (interface, alias, generic args, etc.) in-file
 *   4. when symbol is null, fall back to the first exported function
 */
import type { IntentSource } from "../types.js";
export declare const typescriptSource: IntentSource;
//# sourceMappingURL=typescript.d.ts.map