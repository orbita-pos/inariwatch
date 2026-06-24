/**
 * GitHub-repo resolver — used by the `/github` slash command to figure
 * out which repo the user means without them having to remember the
 * URL.
 *
 * Flow:
 *   1. Resolve the active repo (existing dock-ipc helper).
 *   2. Read its `[remote "origin"] url` from `.git/config` via the
 *      `desktop_git_origin_url` Rust IPC.
 *   3. Parse the URL into `owner` + `name`. Supports the four formats
 *      git accepts (https, ssh, git+ssh, plain git://).
 *   4. Validate the host is `github.com` so `/github` doesn't silently
 *      open a GitLab / Bitbucket / Gitea repo.
 *
 * Each step can fail independently, and each failure has a distinct
 * user-facing message:
 *
 *   - no active repo                  → "Connect a repo first."
 *   - repo has no .git/config         → "Not a git repo."
 *   - .git/config has no origin       → "Add an `origin` remote."
 *   - origin URL isn't github.com     → "Repo is on `<host>`, not GitHub."
 *
 * The resolver returns a tagged union so the caller can render the
 * right message verbatim.
 */

import { invoke } from "@tauri-apps/api/core";

import { resolveActiveRepo } from "./dock-ipc";

export type GitHubRepoResult =
  | { ok: true; owner: string; name: string; baseUrl: string }
  | { ok: false; reason: GitHubRepoFailure; detail?: string };

export type GitHubRepoFailure =
  | "no-active-repo"
  | "no-origin-remote"
  | "non-github-host";

/**
 * IPC wrapper for `desktop_git_origin_url`. Returns the raw `url`
 * value from `[remote "origin"]` in the repo's `.git/config`, or null
 * when the repo isn't tracked / has no origin remote.
 *
 * Catches IPC errors and returns null so the resolver doesn't have to
 * try/catch — the network of "repo unknown / config missing / origin
 * missing" all collapse to the same null path.
 */
export async function desktopGitOriginUrl(
  repoId: string,
): Promise<string | null> {
  try {
    return await invoke<string | null>("desktop_git_origin_url", { repoId });
  } catch {
    return null;
  }
}

/**
 * Parse a git remote URL into `owner` + `name`. Returns null when the
 * URL isn't a github.com URL (any of the four supported shapes).
 *
 * Pure function — exposed for tests.
 */
export function parseGitHubRepo(
  url: string,
): { owner: string; name: string } | null {
  const trimmed = url.trim();
  // The four formats git accepts for a remote URL, all anchored at
  // github.com:
  //   - https://github.com/owner/name(.git)?
  //   - git@github.com:owner/name(.git)?
  //   - ssh://git@github.com/owner/name(.git)?
  //   - git://github.com/owner/name(.git)?
  const re =
    /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/|git:\/\/github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;
  const match = trimmed.match(re);
  if (!match) return null;
  return { owner: match[1]!, name: match[2]! };
}

/**
 * Detect the host of a non-github URL so the error message can name
 * it ("Repo is on gitlab.com, not GitHub"). Returns null when the URL
 * doesn't parse — caller falls back to "non-GitHub remote".
 */
export function detectHost(url: string): string | null {
  const trimmed = url.trim();
  // https://host/... or git://host/... or git@host:owner/name
  const httpsMatch = trimmed.match(/^[a-z]+:\/\/([^/]+)\//i);
  if (httpsMatch) return httpsMatch[1] ?? null;
  const sshMatch = trimmed.match(/^[^@]+@([^:]+):/);
  if (sshMatch) return sshMatch[1] ?? null;
  return null;
}

/**
 * Combine `resolveActiveRepo` + `desktopGitOriginUrl` + `parseGitHubRepo`
 * into a single call the slash-dispatcher can `await` once. Defensive
 * about every failure mode so the caller doesn't have to nest checks.
 */
export async function resolveActiveGitHubRepo(): Promise<GitHubRepoResult> {
  const active = await resolveActiveRepo();
  if (!active) {
    return { ok: false, reason: "no-active-repo" };
  }

  const originUrl = await desktopGitOriginUrl(active.id);
  if (!originUrl) {
    return { ok: false, reason: "no-origin-remote" };
  }

  const parsed = parseGitHubRepo(originUrl);
  if (!parsed) {
    return {
      ok: false,
      reason: "non-github-host",
      detail: detectHost(originUrl) ?? originUrl,
    };
  }

  return {
    ok: true,
    owner: parsed.owner,
    name: parsed.name,
    baseUrl: `https://github.com/${parsed.owner}/${parsed.name}`,
  };
}

/**
 * Map a `/github` subcommand to the sub-path on github.com.
 *
 *   bare                     → ""           (repo home)
 *   prs / pulls              → "/pulls"
 *   issues                   → "/issues"
 *   actions                  → "/actions"
 *   releases                 → "/releases"
 *   anything else            → null         (caller surfaces "unknown subcommand")
 *
 * Pure function — exposed for tests.
 */
export function githubSubpath(subcommand: string): string | null {
  const sub = subcommand.trim().toLowerCase();
  if (sub === "") return "";
  if (sub === "prs" || sub === "pulls") return "/pulls";
  if (sub === "issues") return "/issues";
  if (sub === "actions") return "/actions";
  if (sub === "releases") return "/releases";
  return null;
}
