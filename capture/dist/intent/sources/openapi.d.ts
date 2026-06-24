/**
 * OpenAPI source — extracts request-body / parameter schema from an
 * `openapi.json` / `openapi.yaml` / `swagger.json` discovered at the
 * project root or under `docs/` (SKYNET §3 piece 5, Track D, part 2).
 *
 * Why this matters: the LLM seeing `evidence.request.body` is half the
 * picture — the other half is "what did the API contract say it should
 * be". For teams that maintain an OpenAPI document, that contract is
 * authoritative, more accurate than the TS types (which lie about
 * runtime shape), and trivially indexed.
 *
 * Strategy:
 *   1. Walk up from the failing file to a project root (package.json
 *      marker). Cache the resolved spec path per root.
 *   2. Look for spec files in this priority order:
 *        ./openapi.json, ./openapi.yaml, ./openapi.yml,
 *        ./swagger.json, ./swagger.yaml, ./swagger.yml,
 *        ./docs/openapi.{json,yaml,yml}, ./docs/swagger.{json,yaml,yml}
 *   3. Parse the spec — JSON via the runtime, YAML via an optional peer
 *      (`yaml` then `js-yaml`). If neither peer is installed and the
 *      spec is YAML, we silently skip the source.
 *   4. Build two indexes: by `operationId` and by `path` (with
 *      Next.js-style `[param]` <-> OpenAPI `{param}` normalization).
 *   5. Resolve in this order:
 *        a. `symbol` matches an `operationId`
 *        b. `filePath` maps to an OpenAPI path (Next.js app-router
 *           convention)
 *        c. fall through to `null`
 *   6. Return the operation's request-body JSON schema (preferring
 *      `application/json`); fall back to merged path/query parameter
 *      schemas for GET-style operations.
 *
 * The source is best-effort and degradation-safe: any failure (no spec,
 * unparseable YAML, malformed schema) returns `null`, the compiler asks
 * the next source.
 */
import type { IntentSource } from "../types.js";
export declare const openapiSource: IntentSource;
export declare function __resetOpenapiCacheForTesting(): void;
//# sourceMappingURL=openapi.d.ts.map