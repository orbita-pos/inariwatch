/**
 * Shared helpers for resolving the canonical `owner/repo` string from
 * whatever each webhook source provides.
 *
 * Used by every webhook handler to populate `alerts.repo` at ingest time
 * (migration 0068). Keeps URL parsing + validation in one place so every
 * source agrees on what counts as a valid repo identifier.
 */

const OWNER_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Accepts anything a webhook might carry that identifies a repo and
 * returns a canonical `owner/repo` string, or null if it can't be
 * parsed.
 *
 * Accepted inputs:
 *   - `owner/repo`                               → `owner/repo`
 *   - `https://github.com/owner/repo`            → `owner/repo`
 *   - `https://github.com/owner/repo.git`        → `owner/repo`
 *   - `git@github.com:owner/repo.git`            → `owner/repo`
 *   - `git+https://github.com/owner/repo.git`    → `owner/repo`
 *   - `ssh://git@github.com/owner/repo.git`      → `owner/repo`
 *
 * Also works for GitLab/Bitbucket URLs — we just extract the last two
 * path segments regardless of host. The remediation flow needs
 * `owner/repo` and validates against GitHub's API separately.
 */
export function normalizeRepo(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw) return null;

  // Strip common URL prefixes
  let s = raw
    .replace(/^git\+/, "")
    .replace(/^ssh:\/\/git@/, "")
    .replace(/^git@/, "")
    .replace(/^https?:\/\//, "");

  // SSH uses `host:owner/repo`, not `host/owner/repo` — normalize.
  s = s.replace(/^([^:/]+):/, "$1/");

  // If it looks like a URL/host, drop everything up to (and including) the host.
  if (s.includes("/")) {
    const parts = s.split("/").filter(Boolean);
    // Take the last two path segments — works for github.com/a/b,
    // gitlab.com/group/project, custom/host/a/b, etc.
    if (parts.length >= 2) {
      const ownerCandidate = parts[parts.length - 2];
      const repoCandidate = parts[parts.length - 1].replace(/\.git$/, "");
      const joined = `${ownerCandidate}/${repoCandidate}`;
      if (OWNER_REPO_RE.test(joined)) return joined;
    }
  }

  // Fallback: maybe it's already `owner/repo`.
  const stripped = raw.replace(/\.git$/, "");
  if (OWNER_REPO_RE.test(stripped)) return stripped;

  return null;
}

/**
 * Webhook-specific resolver for capture events. The SDK's `git` payload
 * may carry `repo` (new in v0.10, `owner/repo`) or `url` (from
 * package.json#repository or the git remote). Falls back to
 * correlationData metadata for legacy SDK versions.
 */
export function resolveRepoFromCaptureEvent(event: {
  git?: { repo?: unknown; url?: unknown } | null;
  metadata?: { repo?: unknown } | null;
}): string | null {
  return (
    normalizeRepo(event.git?.repo) ??
    normalizeRepo(event.git?.url) ??
    normalizeRepo(event.metadata?.repo) ??
    null
  );
}

/**
 * Webhook-specific resolver for Vercel deployment payloads. Vercel
 * sends `deployment.gitSource` (or `meta.githubRepo` on older schemas)
 * with the source repo.
 */
export function resolveRepoFromVercelPayload(dep: {
  gitSource?: { org?: unknown; repo?: unknown; type?: unknown } | null;
  meta?: { githubCommitRepo?: unknown; githubRepo?: unknown; githubOrg?: unknown } | null;
}): string | null {
  const gs = dep.gitSource;
  if (gs && typeof gs === "object") {
    const type = typeof gs.type === "string" ? gs.type : "";
    if (type === "github" || type === "") {
      const combined = `${String(gs.org ?? "").trim()}/${String(gs.repo ?? "").trim()}`;
      const n = normalizeRepo(combined);
      if (n) return n;
    }
  }
  const meta = dep.meta;
  if (meta && typeof meta === "object") {
    const org = String(meta.githubOrg ?? "").trim();
    const repo = String(meta.githubCommitRepo ?? meta.githubRepo ?? "").trim();
    if (org && repo) {
      const n = normalizeRepo(`${org}/${repo}`);
      if (n) return n;
    }
  }
  return null;
}

/**
 * GitHub webhook — `repository.full_name` is always `owner/repo`.
 */
export function resolveRepoFromGithubPayload(payload: {
  repository?: { full_name?: unknown } | null;
}): string | null {
  return normalizeRepo(payload.repository?.full_name);
}

/**
 * Sentry webhook — no direct repo field, but integration config can
 * map `project.slug` → `owner/repo`. Caller passes that map.
 */
export function resolveRepoFromSentryPayload(
  payload: { project?: { slug?: unknown } | null; project_slug?: unknown },
  sentryToGithubRepoMap: Record<string, string> | null,
): string | null {
  const slug = String(
    (payload.project as { slug?: unknown } | null)?.slug ??
    payload.project_slug ??
    "",
  ).trim();
  if (!slug || !sentryToGithubRepoMap) return null;
  return normalizeRepo(sentryToGithubRepoMap[slug]);
}

/**
 * Datadog webhook — repo sometimes appears as a tag `repo:owner/name`
 * or `github_repository:owner/name`. Caller extracts tags array.
 */
export function resolveRepoFromDatadogTags(tags: unknown): string | null {
  if (!Array.isArray(tags)) return null;
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const match = tag.match(/^(?:repo|github_repository|git\.repository_url|git\.repository\.name):(.+)$/);
    if (match) {
      const n = normalizeRepo(match[1]);
      if (n) return n;
    }
  }
  return null;
}
