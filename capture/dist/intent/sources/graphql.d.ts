/**
 * GraphQL source — extracts a JSON-Schema-flavored shape from `*.graphql` /
 * `*.gql` SDL files (SKYNET §3 piece 5, Track D, part 3).
 *
 * Why GraphQL: when a resolver throws, the most useful "expected" shape is
 * the input type declared in the SDL — `input CreateUserInput { email:
 * String! age: Int }` — not the runtime resolver signature (often `any`)
 * and not the TS gateway types (which lie about non-null modifiers).
 *
 * Strategy:
 *   1. Walk up from the failing file to a project root (`package.json`).
 *   2. Discover any `*.graphql` / `*.gql` file under the root, with the
 *      same priority spec the OpenAPI source uses (root > schema/ > graphql/
 *      > docs/). Cache results per root, invalidate on mtime.
 *   3. Parse via the `graphql` peer (optional). When the peer is missing
 *      we silently skip — same pattern as the YAML peer for OpenAPI.
 *   4. Build two indexes:
 *        a. `byTypeName` — every Object/Input/Interface name → its shape
 *        b. `byFieldArgs` — every Query/Mutation/Subscription field name →
 *           the merged input shape of its arguments
 *   5. Resolve order: `symbol` matches a type → that type. `symbol`
 *      matches a Query/Mutation field → its args. Fall back to the first
 *      Input type, then the first Object type.
 *
 * Modifiers map straightforwardly: `!` → required, `[T]` → array, `[T!]!`
 * → non-null array of non-null T. Scalars map to `string|number|boolean`,
 * with `Int` → number, `Float` → number, `ID`/`String` → string, `Boolean`
 * → boolean, `DateTime`/`Date` → string with format. Enums become
 * `{ type: "string", enum: [...values] }`. Unknown scalars degrade to
 * `unknown` (the LLM still sees the field exists).
 *
 * Best-effort: malformed SDL, missing peer, or no schema files all return
 * `null` and the next source gets a turn.
 */
import type { IntentSource } from "../types.js";
export declare const graphqlSource: IntentSource;
export declare function __resetGraphqlCacheForTesting(): void;
//# sourceMappingURL=graphql.d.ts.map