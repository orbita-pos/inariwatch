/**
 * Pure stack-frame parser — converts the `stack` strings shipped by the
 * capture SDK (browser-flavoured JS error.stack) into structured frames
 * the player can render and (eventually) source-map-resolve.
 *
 * Browsers ship two main stack formats:
 *   Chromium / Node V8:
 *     `    at functionName (https://app/foo.js:42:7)`
 *     `    at https://app/anon.js:1:1`
 *   Firefox / Safari (older):
 *     `functionName@https://app/foo.js:42:7`
 *
 * Either way each frame carries a URL (or filename), line, optional col,
 * and optional function name. Anything else is ignored.
 *
 * `mapped` stays null today — a follow-up worker will populate it after
 * fetching .map files from the deployed asset URL. The schema is fixed
 * now so the player UI works for both states.
 */

export interface StackFrame {
  fnName: string | null;
  source: string;       // raw URL or path from the stack line
  line: number;
  col: number | null;
  /** Set later by the source-map resolver. Null when no map could be loaded. */
  mapped: { file: string; line: number; col: number | null; fnName?: string | null } | null;
}

const V8_RE = /^\s*at (?:(.+?) \()?(.+?):(\d+)(?::(\d+))?\)?$/;
const SPIDERMONKEY_RE = /^(.*?)@(.+?):(\d+)(?::(\d+))?$/;

/**
 * Parse a JS error.stack string into structured frames. Drops lines that
 * don't match either format (the leading `TypeError: foo` line, blank
 * lines, etc.). Caps the frame count to defend against pathological
 * stacks (recursion bombs).
 */
export function parseStack(stack: string | null | undefined, maxFrames = 50): StackFrame[] {
  if (!stack || typeof stack !== "string") return [];
  const out: StackFrame[] = [];
  for (const rawLine of stack.split("\n")) {
    if (out.length >= maxFrames) break;
    const line = rawLine.trim();
    if (!line) continue;

    let m = V8_RE.exec(line);
    if (m) {
      out.push({
        fnName: m[1] ? m[1].trim() : null,
        source: m[2],
        line: parseInt(m[3], 10),
        col: m[4] ? parseInt(m[4], 10) : null,
        mapped: null,
      });
      continue;
    }
    m = SPIDERMONKEY_RE.exec(line);
    if (m) {
      out.push({
        fnName: m[1] ? m[1] : null,
        source: m[2],
        line: parseInt(m[3], 10),
        col: m[4] ? parseInt(m[4], 10) : null,
        mapped: null,
      });
    }
    // Non-matching lines (the error message header, browser-native
    // `<anonymous>`, etc.) are silently dropped — they're not actionable.
  }
  return out;
}

export interface ResolvedError {
  fingerprint: string;
  message: string;
  /** Number of times this fingerprint fired in the session. */
  count: number;
  /** Session-relative ms of the FIRST occurrence. */
  firstTimestamp: number;
  /** Pre-parsed stack frames; empty when the SDK couldn't capture one. */
  frames: StackFrame[];
}

interface RawErrorEvent {
  fingerprint: string;
  timestamp: number;
  message: string;
  stack?: string;
}

/**
 * Group a session's `_kind: "error"` events by fingerprint and produce
 * the structured array the dashboard renders. The first occurrence wins
 * for `message` + `frames` (later occurrences are usually identical
 * anyway; users care about "how many times" not "every variation").
 *
 * `sessionStartMs` lets us emit session-relative timestamps so the
 * player's seek logic doesn't need to subtract again.
 */
export function aggregateErrors(
  events: RawErrorEvent[],
  sessionStartMs: number,
): ResolvedError[] {
  const byFp = new Map<string, ResolvedError>();
  for (const e of events) {
    const existing = byFp.get(e.fingerprint);
    if (existing) {
      existing.count++;
      continue;
    }
    byFp.set(e.fingerprint, {
      fingerprint: e.fingerprint,
      message: e.message,
      count: 1,
      firstTimestamp: Math.max(0, e.timestamp - sessionStartMs),
      frames: parseStack(e.stack),
    });
  }
  // Sort by firstTimestamp so the panel reads in the order errors fired.
  return Array.from(byFp.values()).sort((a, b) => a.firstTimestamp - b.firstTimestamp);
}

/**
 * Best-effort GitHub blob URL builder. Used by the player to turn a stack
 * frame into a clickable link. Returns null when the source doesn't look
 * like it maps to anything in the configured repo (third-party, browser
 * extensions, anonymous evals, etc.).
 *
 * Strategy: take the URL's pathname, strip the leading "/_next/static/"
 * or framework-specific prefixes, then assume it's a path inside the repo.
 * This is wrong without source maps, but gives a useful "open in repo"
 * affordance until we resolve maps properly.
 */
export function buildGithubLink(opts: {
  source: string;
  line: number;
  githubOwner: string;
  githubRepo: string;
  branch?: string;
}): string | null {
  const { source, line, githubOwner, githubRepo, branch } = opts;
  if (!source || !githubOwner || !githubRepo) return null;
  // Drop non-http(s) origins outright — browser extensions, data: URLs,
  // blob:, native eval frames. None of these map to the customer's repo.
  if (/^(?:chrome-extension|moz-extension|safari-web-extension|data|blob|about):/i.test(source)) {
    return null;
  }
  let path: string;
  try {
    const u = new URL(source);
    path = u.pathname.replace(/^\//, "");
  } catch {
    // Not an absolute URL — assume it's already a repo-relative path.
    path = source.replace(/^\//, "");
  }
  if (!path) return null;
  // Skip obvious bundler artefacts that won't exist in source.
  if (path.includes("_next/static/chunks/") || path.endsWith(".js.map")) {
    return null;
  }
  const ref = branch ?? "main";
  return `https://github.com/${githubOwner}/${githubRepo}/blob/${ref}/${path}#L${line}`;
}
