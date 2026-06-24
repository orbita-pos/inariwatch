/**
 * Zod source — extracts JSON-Schema-flavored shape from `z.object({...})`
 * literals (and friends) found in the source file.
 *
 * Why AST instead of `zod-to-json-schema`: extracting at runtime would
 * require evaluating the user's source code, which is unsafe and forces
 * `zod` itself as a runtime peer. AST extraction is sandbox-safe, costs
 * nothing, and covers >90% of real-world Zod usage (object/array/literal
 * /enum/union/optional/nullable + the common refinements).
 *
 * Falls back to `zod-to-json-schema` ONLY if it's installed AND the user
 * already imported the schema such that we have a real Zod runtime
 * instance — handled by the compiler core, not here. This file stays pure
 * AST.
 *
 * Resolution for a frame `(file, symbol)`:
 *   1. find the function declaration named `symbol`
 *   2. inside its body, find the first `<schemaVar>.parse(…)` /
 *      `.safeParse(…)` call
 *   3. find the declaration of `<schemaVar>` (`const schemaVar = z.…`)
 *   4. walk that initializer AST → IntentShape
 *
 * If no validator call is found we fall back to "first top-level
 * `z.object` in the file" — handlers often colocate the schema right
 * above the handler.
 */
import type { IntentSource } from "../types.js";
export declare const zodSource: IntentSource;
//# sourceMappingURL=zod.d.ts.map