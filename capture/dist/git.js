/**
 * Git context — captured at build time via withInariWatch plugin,
 * read at runtime from injected env vars.
 */
/**
 * Read git context from env vars injected by withInariWatch at build time.
 * Returns null if no git context is available (e.g., no .git directory).
 */
export function getGitContext() {
    if (typeof process === "undefined" || !process.env)
        return null;
    const commit = process.env.INARIWATCH_GIT_COMMIT;
    if (!commit)
        return null;
    return {
        commit,
        branch: process.env.INARIWATCH_GIT_BRANCH || "unknown",
        message: process.env.INARIWATCH_GIT_MESSAGE || "",
        timestamp: process.env.INARIWATCH_GIT_TIMESTAMP || "",
        dirty: process.env.INARIWATCH_GIT_DIRTY === "true",
    };
}
/**
 * Extract git info at build time (runs in Node.js during next build).
 * Used by withInariWatch plugin.
 */
export function extractGitInfo() {
    try {
        const { execSync } = require("child_process");
        const run = (cmd) => {
            try {
                return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
            }
            catch {
                return "";
            }
        };
        const message = run("git log -1 --format=%s").slice(0, 200);
        // Scrub potential secrets from commit message
        const safeMessage = message
            .replace(/(?:sk|pk|api|key|token|secret|password)[_-]?\S{8,}/gi, "[REDACTED]")
            .replace(/:\/\/[^:]+:[^@]+@/g, "://[REDACTED]@");
        return {
            INARIWATCH_GIT_COMMIT: run("git rev-parse HEAD"),
            INARIWATCH_GIT_BRANCH: run("git rev-parse --abbrev-ref HEAD"),
            INARIWATCH_GIT_MESSAGE: safeMessage,
            INARIWATCH_GIT_TIMESTAMP: run("git log -1 --format=%cI"),
            INARIWATCH_GIT_DIRTY: run("git status --porcelain").length > 0 ? "true" : "false",
        };
    }
    catch {
        return {};
    }
}
//# sourceMappingURL=git.js.map