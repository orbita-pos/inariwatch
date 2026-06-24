/**
 * Pure string-insertion helpers for the CLI framework-setup functions.
 *
 * Each function takes the raw content of a user's framework config file and
 * returns the transformed content plus a status describing what happened.
 * No file I/O — callers (`cli.ts`) wrap these in readFileSync/writeFileSync.
 *
 * Keeping these pure makes them trivially testable: see
 * `capture/test-setup/run-tests.mjs` for fixture-based validation.
 */
export type InsertStatus = "inserted" | "already-present" | "no-insertion-point" | "new-block-inserted";
export interface InsertResult {
    content: string;
    status: InsertStatus;
}
/**
 * Insert `inariwatchVite()` into a vite.config file's existing `plugins: [...]`
 * array. Also prepends the import.
 *
 * Handles Vite, Remix, SvelteKit, SolidStart, Qwik — they all use vite.config.*
 */
export declare function insertViteConfig(content: string): InsertResult;
/**
 * Insert `"@inariwatch/capture/nuxt"` into a nuxt.config file's `modules: [...]`
 * array. If the config has no `modules` array, insert one inside
 * `defineNuxtConfig({ ... })`.
 */
export declare function insertNuxtConfig(content: string): InsertResult;
/**
 * Insert `inariwatchVite()` into an astro.config file's `vite.plugins: [...]`
 * array. If there's a `vite: { ... }` block without `plugins`, inject the
 * plugins array inside it. If there's no `vite` block, bail out.
 */
export declare function insertAstroConfig(content: string): InsertResult;
/**
 * Wrap a Next.js config file with `withInariWatch(...)`. Handles `.ts`, `.mjs`,
 * and `.js` / `.cjs` CommonJS forms.
 */
export declare function insertNextConfig(content: string): InsertResult;
//# sourceMappingURL=setup-inserters.d.ts.map