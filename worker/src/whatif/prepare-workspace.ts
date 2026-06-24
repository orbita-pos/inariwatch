/**
 * Prepare a working directory for What-If Substrate replay.
 *
 * Clones the user's repo at the fix commit (shallow, one commit deep),
 * overwrites files from the remediation's `fileChanges`, and returns the
 * path. Caller is responsible for calling `cleanup()` in a finally block.
 *
 * Why shallow clone: we only need the tree at one commit. Shallow + no
 * blobless brings a typical JS repo from ~500MB to ~5-20MB on disk and
 * from 30-60s to ~3-5s over fast network.
 *
 * Why overwrite instead of `git apply` a patch: remediation.fileChanges
 * stores the FINAL content of each changed file, not a diff. The agent
 * AI writes full files because diffs that span many lines are fragile
 * (whitespace drift, overlapping hunks). Overwriting matches how the
 * agent pushed those files to the branch — same bytes end up on disk.
 *
 * Security: `git clone` receives the URL as an argv, not a shell command,
 * so there's no shell injection risk on the repo slug. The GitHub auth
 * token travels in the URL's userinfo portion; we scrub it from error
 * messages before propagating.
 */

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, open, lstat, rm } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

export interface PrepareWorkspaceInput {
  /** Repo slug like "orbita-pos/inariwatch". */
  repo: string;
  /** Commit SHA to checkout. Shallow clone targets this commit directly. */
  commitSha: string;
  /** Files from remediation.fileChanges — full content replaces whatever
   *  was at the checked-out commit. Paths are relative to repo root. */
  fileChanges: Array<{ path: string; content: string }>;
  /** GitHub token for cloning private repos. When omitted, attempts an
   *  anonymous clone — works for public repos only. */
  githubToken?: string;
  /** How long to wait for `git clone` before giving up. Default 90s
   *  which covers typical 20-100MB repos on Hetzner's 1Gbps link. */
  cloneTimeoutMs?: number;
}

export interface PreparedWorkspace {
  /** Absolute path to the checkout. Safe to pass as cwd to substrate. */
  path: string;
  /** Call in a finally block — rm -rf the temp dir. Idempotent, swallow
   *  errors (cleanup failures shouldn't mask the real request error). */
  cleanup: () => Promise<void>;
}

export class PrepareWorkspaceError extends Error {
  constructor(message: string, public readonly phase: "clone" | "checkout" | "patch") {
    super(message);
  }
}

export async function prepareWorkspace(input: PrepareWorkspaceInput): Promise<PreparedWorkspace> {
  const tempRoot = await mkdtemp(join(tmpdir(), "iw-whatif-ws-"));
  const cleanup = async () => {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  };

  try {
    const cloneUrl = buildCloneUrl(input.repo, input.githubToken);
    // Shallow clone at the specific commit. Requires git 2.5+ for
    // `--depth=1` with a commit SHA (previously only branch names worked).
    await runGit([
      "clone",
      "--depth=1",
      "--filter=blob:none",  // skip file contents until checkout needs them
      "--no-tags",
      cloneUrl,
      tempRoot,
    ], tempRoot, input.cloneTimeoutMs ?? 90_000, input.githubToken, "clone");

    // Some providers reject shallow clones of arbitrary SHAs (GitHub
    // allows it for public + authenticated private). Fetch the specific
    // commit and check it out. If the initial clone pointed at HEAD, the
    // commit may not be in the shallow history yet.
    await runGit(["fetch", "--depth=1", "origin", input.commitSha], tempRoot, 60_000, input.githubToken, "clone");
    await runGit(["checkout", input.commitSha], tempRoot, 15_000, input.githubToken, "checkout");

    // Apply fileChanges — write each file's full content, creating parent
    // directories as needed. Mirrors how the remediation agent pushed the
    // branch (same bytes end up on disk).
    //
    // Symlink safety: a malicious repo can commit a symlink like
    // `docs -> /etc`, and an attacker-controlled remediation could then
    // emit fileChanges like `{ path: "docs/passwd", content: "..." }` to
    // escape the workspace. isSafePath only catches syntactic traversal
    // (`..`, absolute); symlinks require runtime inspection, which we do
    // in two layers: (1) lstat each ancestor component before mkdir and
    // reject if any is a symlink, (2) open the target file with O_NOFOLLOW
    // so a symlink created after our ancestor check (TOCTOU race window)
    // fails the open itself.
    for (const change of input.fileChanges) {
      if (!isSafePath(change.path)) {
        throw new PrepareWorkspaceError(
          `refusing to write outside workspace: ${change.path}`,
          "patch",
        );
      }
      await ensureNoSymlinksInAncestors(tempRoot, change.path);
      const target = join(tempRoot, change.path);
      await mkdir(dirname(target), { recursive: true });
      // O_NOFOLLOW makes open() fail with ELOOP if the final path
      // component is a symlink. O_TRUNC overwrites existing content.
      // File mode 0o644 — owner rw, others read; matches writeFile default.
      const fh = await open(
        target,
        FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC | FS.O_NOFOLLOW,
        0o644,
      ).catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ELOOP") {
          throw new PrepareWorkspaceError(
            `refusing to write through symlink: ${change.path}`,
            "patch",
          );
        }
        throw e;
      });
      try {
        await fh.writeFile(change.content, "utf-8");
      } finally {
        await fh.close();
      }
    }

    return { path: tempRoot, cleanup };
  } catch (err) {
    // On any failure, clean up the temp dir before propagating. The
    // caller can't know about tempRoot to clean it themselves.
    await cleanup();
    throw err;
  }
}

// ── Internals ──────────────────────────────────────────────────────────────

/**
 * Inject the GitHub token into the clone URL's userinfo portion. Uses
 * `x-access-token` as the username (GitHub's documented pattern for
 * fine-grained PATs). Public repos get a plain https URL — no token
 * leaks into the process tree for public clones.
 *
 * Exported for the unit test suite; not part of the module's contract.
 */
export function buildCloneUrl(repo: string, token: string | undefined): string {
  if (!token) return `https://github.com/${repo}.git`;
  return `https://x-access-token:${token}@github.com/${repo}.git`;
}

/**
 * Walk each ancestor of `relPath` from `tempRoot` down and reject if any
 * segment is a symlink. Must run BEFORE `mkdir(..., { recursive: true })`
 * because mkdir traverses symlinks — if `tempRoot/docs` is already a
 * symlink to `/etc`, mkdir is happy to create `/etc/subdir`.
 *
 * ENOENT is not an error — it just means the directory doesn't exist yet
 * and we're about to create it. We only care about segments that DO
 * exist and happen to be symlinks.
 *
 * Does NOT check the final file component; that is handled by O_NOFOLLOW
 * on the open() call which catches both "symlink exists at final path"
 * and "symlink gets created between check and write" (TOCTOU).
 *
 * Exported for the unit test suite; not part of the module's contract.
 */
export async function ensureNoSymlinksInAncestors(tempRoot: string, relPath: string): Promise<void> {
  const parts = relPath.replace(/\\/g, "/").split("/");
  let current = tempRoot;
  for (const part of parts.slice(0, -1)) {
    if (!part) continue;
    current = join(current, part);
    let stats;
    try {
      stats = await lstat(current);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue; // ancestor doesn't exist yet — fine
      throw e;
    }
    if (stats.isSymbolicLink()) {
      throw new PrepareWorkspaceError(
        `refusing to write through symlinked ancestor: ${part}`,
        "patch",
      );
    }
  }
}

/**
 * Guard against path traversal in `fileChanges`. Rejects absolute paths
 * and any path containing `..` segments. This is belt-and-suspenders —
 * the remediation agent should never emit such paths, but a compromised
 * AI output could, and we'd rather fail loudly than write outside the
 * workspace.
 *
 * Exported for the unit test suite; not part of the module's contract.
 */
export function isSafePath(path: string): boolean {
  if (path.startsWith("/")) return false;
  if (path.startsWith("\\")) return false;
  if (path.includes("..")) return false;
  if (/^[A-Za-z]:/.test(path)) return false; // Windows drive letters
  return true;
}

/**
 * Spawn `git` with the given args. Scrubs the auth token from error
 * output so it doesn't leak into logs.
 */
function runGit(
  args: string[],
  cwd: string,
  timeoutMs: number,
  token: string | undefined,
  phase: "clone" | "checkout" | "patch",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      shell: false,
      env: { PATH: process.env.PATH ?? "" },
    });

    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new PrepareWorkspaceError(`git ${args[0]} exceeded ${timeoutMs}ms timeout`, phase));
    }, timeoutMs);

    child.stderr?.on("data", (c) => { stderr += c.toString(); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new PrepareWorkspaceError(scrub(err.message, token), phase));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new PrepareWorkspaceError(
          `git ${args[0]} exited ${code}: ${scrub(stderr, token).slice(0, 500)}`,
          phase,
        ));
        return;
      }
      resolve();
    });
  });
}

/** Replace any occurrence of the token with `***` so it never lands in
 *  error logs or exception messages.
 *
 *  Exported for the unit test suite; not part of the module's contract. */
export function scrub(text: string, token: string | undefined): string {
  if (!token) return text;
  return text.split(token).join("***");
}
