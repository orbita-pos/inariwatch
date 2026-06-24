/**
 * Git context — captured at build time via withInariWatch plugin,
 * read at runtime from injected env vars.
 */
export interface GitContext {
    commit: string;
    branch: string;
    message: string;
    timestamp: string;
    dirty: boolean;
}
/**
 * Read git context from env vars injected by withInariWatch at build time.
 * Returns null if no git context is available (e.g., no .git directory).
 */
export declare function getGitContext(): GitContext | null;
/**
 * Extract git info at build time (runs in Node.js during the build step of
 * whichever framework is wrapping capture — Next, Nuxt, Remix, Vite, webpack,
 * etc.). Used by framework plugins to inject git context as env vars.
 */
export declare function extractGitInfo(): Record<string, string>;
//# sourceMappingURL=git.d.ts.map