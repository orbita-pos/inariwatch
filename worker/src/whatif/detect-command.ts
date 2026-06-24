/**
 * Detect the command to run a freshly-checked-out project.
 *
 * Used by the What-If worker pipeline: after we clone the user's repo at
 * the fix commit and apply the remediation patches, we need to know HOW
 * to run the resulting code so Substrate can replay recorded I/O against
 * it. Users run node apps in a hundred different ways (npm start, yarn
 * dev, direct node entry, Dockerfile CMD, pm2 ecosystem, etc.) — this
 * module answers "given a working directory, what's the most likely
 * command?" with a clear fallback ladder.
 *
 * Heuristic priority (most explicit → most speculative):
 *   1. `package.json` → `scripts.start`     → `npm start`
 *   2. `package.json` → `scripts.dev`       → `npm run dev`
 *   3. `Dockerfile` → `CMD ["node", "..."]` → extracted array
 *   4. `Dockerfile` → `CMD node ...`        → shell form
 *   5. Node entry fallbacks (index.js, app.js, server.js exist)
 *   6. null — caller should fall back to AI prediction
 *
 * Why NOT use Procfile / pm2 / nixpacks: too many frameworks to cover
 * reliably. If a user's project doesn't start with npm/node or a
 * Dockerfile, they're in the long tail — the AI path covers them.
 */

import { readFile, access } from "node:fs/promises";
import { join } from "node:path";

export interface DetectedCommand {
  /** Shell command to run (single line, safe for substrate --command). */
  command: string;
  /** Which heuristic matched — used by telemetry + the Admin debug view. */
  source: "npm_start" | "npm_dev" | "dockerfile_exec" | "dockerfile_shell" | "node_entry";
  /** Relative path to the source file that gave us the command. */
  sourceFile: string;
}

/**
 * Walks the heuristic ladder and returns the first match, or null when
 * every heuristic fails. Never throws — malformed package.json or
 * Dockerfile is treated as "no match" and the ladder moves on.
 */
export async function detectCommand(cwd: string): Promise<DetectedCommand | null> {
  // ── 1 + 2: package.json scripts
  const pkg = await readPackageJson(cwd);
  if (pkg) {
    const scripts = pkg.scripts ?? {};
    if (typeof scripts.start === "string" && scripts.start.trim().length > 0) {
      return { command: "npm start", source: "npm_start", sourceFile: "package.json" };
    }
    if (typeof scripts.dev === "string" && scripts.dev.trim().length > 0) {
      return { command: "npm run dev", source: "npm_dev", sourceFile: "package.json" };
    }
  }

  // ── 3 + 4: Dockerfile CMD
  const dockerfile = await readTextFile(join(cwd, "Dockerfile"));
  if (dockerfile) {
    const cmd = parseDockerfileCmd(dockerfile);
    if (cmd) return { ...cmd, sourceFile: "Dockerfile" };
  }

  // ── 5: common node entry points
  for (const entry of ["index.js", "app.js", "server.js", "src/index.js", "src/app.js"]) {
    if (await fileExists(join(cwd, entry))) {
      return { command: `node ${entry}`, source: "node_entry", sourceFile: entry };
    }
  }

  return null;
}

// ── Internals ──────────────────────────────────────────────────────────────

async function readPackageJson(cwd: string): Promise<{ scripts?: Record<string, string> } | null> {
  const raw = await readTextFile(join(cwd, "package.json"));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Malformed package.json — treat as no match, continue ladder.
    return null;
  }
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse the LAST CMD in a Dockerfile. Multi-stage Dockerfiles can have
 * several CMD directives — only the last one matters because earlier
 * stages get discarded. Handles both exec form (`CMD ["node", "x"]`)
 * and shell form (`CMD node x`).
 *
 * Returns null when:
 *   - No CMD directive found
 *   - CMD references a shell script we can't reason about (e.g. `sh -c`)
 *   - Exec-form JSON parse fails
 */
export function parseDockerfileCmd(contents: string): { command: string; source: "dockerfile_exec" | "dockerfile_shell" } | null {
  // Normalize continuations and strip comments. Dockerfile comments start
  // with # at line start after optional whitespace.
  const normalized = contents
    .split("\n")
    .map((l) => l.replace(/^\s*#.*$/, "")) // strip full-line comments
    .join("\n")
    .replace(/\\\n/g, " "); // fold line continuations

  // Find all CMD directives (case-insensitive, beginning of line).
  const matches = [...normalized.matchAll(/^\s*CMD\s+(.+)$/gmi)];
  if (matches.length === 0) return null;

  // Last CMD wins (Dockerfile semantics).
  const lastArg = matches[matches.length - 1][1].trim();

  // Exec form: CMD ["node", "app.js"]
  if (lastArg.startsWith("[")) {
    try {
      const parts = JSON.parse(lastArg) as unknown;
      if (!Array.isArray(parts) || parts.some((p) => typeof p !== "string")) return null;
      const command = (parts as string[]).map(shellQuoteIfNeeded).join(" ");
      return { command, source: "dockerfile_exec" };
    } catch {
      return null;
    }
  }

  // Shell form: CMD node app.js
  // Refuse `sh -c ...` because the actual command is opaque to us and
  // substrate needs to know what process to instrument.
  if (/^(sh|bash)\s+-c\b/.test(lastArg)) return null;
  return { command: lastArg, source: "dockerfile_shell" };
}

/** Quote an argument with single quotes if it contains whitespace/special
 *  shell characters. Keeps "node" as `node` but "my app.js" as `'my app.js'`. */
function shellQuoteIfNeeded(arg: string): string {
  if (/^[A-Za-z0-9_./:+=-]+$/.test(arg)) return arg;
  // Escape embedded single quotes by closing/reopening: foo'bar → 'foo'\''bar'
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
