/**
 * Drizzle source — extracts a JSON-Schema-flavored shape from a
 * `pgTable("name", { columns })` (or `mysqlTable` / `sqliteTable`)
 * declaration in a `*.schema.ts` file (SKYNET §3 piece 5, Track D, part 2).
 *
 * Why: when a write fails inside a Drizzle insert/update, the LLM's most
 * useful "expected schema" is the table definition itself — not the
 * route handler's TS interface and not the Zod validator above the
 * insert. The table is the authoritative shape the database accepts.
 *
 * Strategy: pure AST walk via the `typescript` peer (already required by
 * the TS and Zod sources). We never run user code. We never type-check.
 * We never read sibling files — table-level cross-references degrade to
 * `$ref: "TableName"` like every other source in the compiler.
 *
 * Resolution for a frame `(file, symbol)`:
 *   1. parse the file and collect every `<var> = <pgTable|mysqlTable|sqliteTable>("...", { … })`
 *      declaration into a `tables` map keyed by the variable name AND
 *      by the runtime table name passed as the first arg.
 *   2. if `symbol` matches a key, walk that one.
 *   3. if `symbol` matches a function name in the file (e.g. a
 *      `createUser(input)` repository helper), look inside its body for
 *      `db.insert(<varRef>)` / `.update(<varRef>)` / `.values(<varRef>)`
 *      and walk the referenced table.
 *   4. fall back to the first declared table.
 *
 * The Drizzle column DSL is a chained call: `text("col").primaryKey().notNull()`.
 * We map the root identifier to a JSON Schema type, then collapse
 * modifiers (`.notNull()`, `.primaryKey()`, `.default(...)`,
 * `.references(...)`) into the parent table's `required` set.
 */
import type { IntentSource } from "../types.js";
export declare const drizzleSource: IntentSource;
//# sourceMappingURL=drizzle.d.ts.map