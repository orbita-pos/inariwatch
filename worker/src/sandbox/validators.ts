/**
 * Fase 5 — extracted from worker/src/container-agent.ts so the CodeAct
 * sandbox tool-bindings can reuse the *exact same* validators the
 * individual tools enforce. Single source of truth — adding a new
 * blocked file pattern in one place protects both surfaces.
 *
 * The container-agent re-exports these so existing call sites stay
 * source-compatible without touching their imports.
 *
 * Security rule (GPT54 §B7 Rule 1): "All tool authorization happens in
 * the parent, NOT in the sandbox." These validators are the parent
 * authority. The Pyodide layer never sees them.
 */

export const BLOCKED_FILE_PATTERNS: RegExp[] = [
  /^\.env/,
  /\.env$/,
  /secrets?\./i,
  /credentials?\./i,
  /private[_-]?key/i,
  /\.pem$/,
  /\.key$/,
  /\.cert$/,
  /\.p12$/,
  /\.pfx$/,
  /serviceaccount/i,
  /token\.json$/i,
];

export const BLOCKED_WRITE_PATTERNS: RegExp[] = [
  ...BLOCKED_FILE_PATTERNS,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /bun\.lockb$/,
  /^node_modules\//,
  /\/node_modules\//,
];

export const ALLOWED_COMMANDS: string[] = [
  "npm", "npx", "node", "tsc", "git", "cat", "ls", "grep", "find",
  "mkdir", "cp", "head", "tail", "wc", "diff", "echo", "pwd", "which",
  "pnpm", "yarn", "bun",
];

export const BLOCKED_PATTERNS: RegExp[] = [
  /\brm\s+-rf\s+\//, /\bsudo\b/, /\bchmod\b/, /\bchown\b/, /\bkill\b/, /\bpkill\b/,
  /\bcurl\b/, /\bwget\b/, /\bnc\b/, /\bdd\b/, /\bmkfs\b/, /\bfdisk\b/,
  />\s*\/dev\//, /\|.*\bsh\b/, /\|.*\bbash\b/, /\bsh\s+-c\b/, /\bbash\s+-c\b/, /\bsh\s+[<>|]/,
  /\$\(/, /`[^']*`/, /;\s*\w/,
];

export function isBlockedFile(path: string): boolean {
  const filename = path.split("/").pop() ?? path;
  return BLOCKED_FILE_PATTERNS.some((p) => p.test(filename) || p.test(path));
}

export function isBlockedWrite(path: string): boolean {
  const filename = path.split("/").pop() ?? path;
  return BLOCKED_WRITE_PATTERNS.some((p) => p.test(filename) || p.test(path));
}

export function isCommandAllowed(command: string): { allowed: boolean; reason?: string } {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return { allowed: false, reason: "Command blocked: matches dangerous pattern" };
    }
  }
  const baseCommand = command.trim().split(/\s+/)[0].replace(/^\.\//, "");
  if (!ALLOWED_COMMANDS.includes(baseCommand)) {
    return { allowed: false, reason: `Command "${baseCommand}" is not in the allowed list` };
  }
  return { allowed: true };
}

/**
 * Reject paths that escape the repo root. Used by every write/read
 * binding before the path reaches the gVisor container's filesystem.
 */
export function isPathSafe(path: string): { safe: boolean; reason?: string } {
  if (path.includes("..")) return { safe: false, reason: "path contains '..'" };
  if (path.startsWith("/")) return { safe: false, reason: "path is absolute" };
  return { safe: true };
}
