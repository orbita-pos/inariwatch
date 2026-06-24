/**
 * Prisma source — extracts a JSON-Schema-flavored shape from a
 * `schema.prisma` model (SKYNET §3 piece 5, Track D, part 2).
 *
 * Strategy:
 *   1. Walk up from the failing file to a project root; locate
 *      `schema.prisma` at root, `prisma/schema.prisma`, or
 *      `db/schema.prisma`. Cache results per root.
 *   2. Try `@prisma/internals.getDMMF` (the canonical, version-correct
 *      parser). It's an optional peer — if absent, fall back to a small
 *      regex parser that handles the 95% case (`model X { field Type? }`
 *      with scalar types and optional/list modifiers).
 *   3. Resolve `symbol` → model name (case-insensitive, with simple
 *      pluralization fallback so `getUsers` finds the `User` model).
 *   4. Convert each field to JSON Schema; non-optional fields without a
 *      `@default(...)` go in `required`.
 *
 * The internals API is async, but we only need the parsed schema once
 * per file mtime — we resolve it ahead of `extract()` calls when the
 * peer is available, blocking on a small kernel-style trick: the first
 * `extract()` synchronously reads the file and runs the regex parser,
 * then the parsed result is upgraded if the async DMMF resolves later.
 * In practice the regex parser is fine for the SDK hot path; DMMF is a
 * nice-to-have for fidelity (e.g. `@db.VarChar(255)` length hints).
 */
import type { IntentSource } from "../types.js";
export declare const prismaSource: IntentSource;
export declare function __resetPrismaCacheForTesting(): void;
//# sourceMappingURL=prisma.d.ts.map