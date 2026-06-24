/**
 * GitHub REST API service for AI remediation.
 * Handles: reading files, creating branches, committing, creating PRs, checking CI status.
 */

const API = "https://api.github.com";

/** Build URL-safe repo path with encoded owner/repo */
function repoPath(owner: string, repo: string): string {
  return `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "InariWatch-Remediation/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * GitHub API fetch with exponential backoff.
 * Retries on 429 (rate limit) and 5xx (server error) up to 3 times.
 */
async function ghFetch(url: string, init?: RequestInit): Promise<Response> {
  const MAX_RETRIES = 3;
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 && res.status < 500) return res;
    lastResponse = res;
    if (attempt === MAX_RETRIES) break;
    const retryAfter = res.headers.get("retry-after");
    let waitMs = Math.min(1000 * Math.pow(2, attempt), 30_000);
    if (retryAfter) {
      const parsed = parseInt(retryAfter, 10);
      if (!isNaN(parsed) && parsed > 0) {
        waitMs = Math.min(parsed * 1000, 60_000);
      }
    }
    await new Promise((r) => setTimeout(r, waitMs));
  }

  return lastResponse!;
}

// ── Repo info ────────────────────────────────────────────────────────────────

export async function getDefaultBranch(token: string, owner: string, repo: string): Promise<string> {
  const res = await ghFetch(`${repoPath(owner, repo)}`, { headers: headers(token) });
  if (!res.ok) throw new Error(`Failed to get repo info (${res.status})`);
  const data = await res.json();
  return data.default_branch ?? "main";
}

export async function getBranchSha(token: string, owner: string, repo: string, branch: string): Promise<string> {
  const res = await ghFetch(`${API}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, {
    headers: headers(token),
  });
  if (!res.ok) throw new Error(`Failed to get branch SHA (${res.status})`);
  const data = await res.json();
  return data.object.sha;
}

export async function getRepoTree(token: string, owner: string, repo: string, ref: string): Promise<string[]> {
  const res = await ghFetch(`${API}/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, {
    headers: headers(token),
  });
  if (!res.ok) throw new Error(`Failed to get repo tree (${res.status})`);
  const data = await res.json();
  return (data.tree ?? [])
    .filter((t: { type: string; size?: number }) => t.type === "blob" && (t.size ?? 0) < 500_000)
    .map((t: { path: string }) => t.path);
}

// ── File operations ──────────────────────────────────────────────────────────

export async function getFileContent(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref?: string
): Promise<string | null> {
  let url = `${API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  if (ref) url += `?ref=${encodeURIComponent(ref)}`;
  const res = await ghFetch(url, { headers: headers(token) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to read ${path} (${res.status})`);
  const data = await res.json();
  if (data.encoding === "base64") {
    return Buffer.from(data.content, "base64").toString("utf8");
  }
  return data.content ?? null;
}

// ── Branch + Commit (Git Tree API) ──────────────────────────────────────────

export async function createBranch(
  token: string,
  owner: string,
  repo: string,
  name: string,
  sha: string
): Promise<void> {
  const res = await ghFetch(`${API}/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ ref: `refs/heads/${name}`, sha }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Failed to create branch (${res.status}): ${err}`);
  }
}

export async function commitFiles(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  message: string,
  files: { path: string; content: string }[]
): Promise<string> {
  const h = headers(token);

  // 1. Current commit SHA
  const branchSha = await getBranchSha(token, owner, repo, branch);

  // 2. Get the base tree
  const commitRes = await ghFetch(`${API}/repos/${owner}/${repo}/git/commits/${branchSha}`, { headers: h });
  if (!commitRes.ok) throw new Error(`Failed to get commit (${commitRes.status})`);
  const commitData = await commitRes.json();
  const baseTreeSha = commitData.tree.sha;

  // 3. Create blobs (normalize paths — AI may emit "./path" which GitHub rejects)
  const tree = await Promise.all(
    files.map(async (f) => {
      const cleanPath = f.path.replace(/^\.\//, "");
      const blobRes = await ghFetch(`${API}/repos/${owner}/${repo}/git/blobs`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ content: f.content, encoding: "utf-8" }),
      });
      if (!blobRes.ok) throw new Error(`Failed to create blob for ${cleanPath} (${blobRes.status})`);
      const blob = await blobRes.json();
      return { path: cleanPath, mode: "100644" as const, type: "blob" as const, sha: blob.sha as string };
    })
  );

  // 4. Create new tree
  const treeRes = await ghFetch(`${API}/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ base_tree: baseTreeSha, tree }),
  });
  if (!treeRes.ok) {
    const err = await treeRes.text().catch(() => "");
    throw new Error(`Failed to create tree (${treeRes.status}): ${err}`);
  }
  const treeData = await treeRes.json();

  // 5. Create commit
  const newCommitRes = await ghFetch(`${API}/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ message, tree: treeData.sha, parents: [branchSha] }),
  });
  if (!newCommitRes.ok) throw new Error(`Failed to create commit (${newCommitRes.status})`);
  const newCommit = await newCommitRes.json();

  // 6. Update branch ref
  const updateRes = await ghFetch(`${API}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: "PATCH",
    headers: h,
    body: JSON.stringify({ sha: newCommit.sha }),
  });
  if (!updateRes.ok) throw new Error(`Failed to update branch ref (${updateRes.status})`);

  return newCommit.sha as string;
}

// ── Pull Requests ────────────────────────────────────────────────────────────

export async function createPR(
  token: string,
  owner: string,
  repo: string,
  title: string,
  body: string,
  head: string,
  base: string,
  draft = true
): Promise<{ url: string; number: number }> {
  const res = await ghFetch(`${API}/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ title, body, head, base, draft }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Failed to create PR (${res.status}): ${err}`);
  }
  const data = await res.json();
  return { url: data.html_url, number: data.number };
}

export async function mergePR(
  token: string,
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ sha: string }> {
  const res = await ghFetch(`${API}/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
    method: "PUT",
    headers: headers(token),
    body: JSON.stringify({ merge_method: "squash" }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Failed to merge PR (${res.status}): ${err}`);
  }
  const data = await res.json();
  return { sha: data.sha ?? "" };
}

// ── CI Status ────────────────────────────────────────────────────────────────

export type CIStatus = "pending" | "success" | "failure" | "in_progress";

export type CheckDetail = { name: string; status: string; conclusion: string | null };

/**
 * Fetch the list of required status-check contexts for a branch.
 *
 * Returns:
 *   - `string[]` with the names of required checks when branch protection
 *     is configured. Empty array when protection exists but no checks
 *     are required (caller treats this the same as null).
 *   - `null` when the branch has NO protection rules (404), we lack
 *     permission (403), or any other non-200 response. Callers then
 *     fall back to "wait for all checks" — the previous behavior.
 *
 * Used by the CI-wait loop in `remediate.ts` so we only block on the
 * checks GitHub's merge API would actually require. On a typical repo
 * with slow optional checks (coverage, audit, etc.) this cuts 10-60s
 * off the wait without changing safety semantics — GitHub's own merge
 * gate still enforces the required list.
 */
export async function getRequiredStatusChecks(
  token: string,
  owner: string,
  repo: string,
  branch: string
): Promise<string[] | null> {
  const res = await ghFetch(
    `${API}/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`,
    { headers: headers(token) }
  );
  if (!res.ok) return null;

  const data = await res.json().catch(() => null);
  if (!data) return null;

  // Branch protection "required_status_checks" shape:
  //   { strict: bool, contexts: string[], checks: [{ context, app_id }] }
  // `contexts` is the legacy field; `checks` is the newer list that
  // supports app-scoped contexts. We merge both to be safe.
  const rsc = data.required_status_checks;
  if (!rsc) return [];

  const names = new Set<string>();
  if (Array.isArray(rsc.contexts)) {
    for (const c of rsc.contexts) if (typeof c === "string") names.add(c);
  }
  if (Array.isArray(rsc.checks)) {
    for (const c of rsc.checks) {
      if (c && typeof c.context === "string") names.add(c.context);
    }
  }
  return Array.from(names);
}

export async function getCheckRunsStatus(
  token: string,
  owner: string,
  repo: string,
  ref: string,
  /**
   * Optional list of required check names. When provided and non-empty,
   * the status is computed ONLY over matching checks — optional checks
   * still appear in `details` but do not hold up the verdict. Pass `null`
   * or `undefined` to restore the previous "wait for all" behavior.
   */
  requiredChecks?: string[] | null
): Promise<{ status: CIStatus; details: CheckDetail[] }> {
  const res = await ghFetch(`${API}/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=100`, {
    headers: headers(token),
  });
  if (!res.ok) throw new Error(`Failed to get check runs (${res.status})`);
  const data = await res.json();

  if (data.total_count === 0) return { status: "pending", details: [] };

  const checks = data.check_runs as { name: string; status: string; conclusion: string | null }[];
  const details = checks.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion }));

  // When the caller supplied a required-check list (non-empty), only
  // those gate the verdict. Unknown optional checks can keep running
  // without holding up the merge.
  const gating = requiredChecks && requiredChecks.length > 0
    ? checks.filter((c) => requiredChecks.includes(c.name))
    : checks;

  // If branch protection requires a check name that hasn't even reported
  // yet (gating list non-empty but no matching checks), treat as pending.
  if (requiredChecks && requiredChecks.length > 0 && gating.length === 0) {
    return { status: "pending", details };
  }

  const allCompleted = gating.every((c) => c.status === "completed");
  if (!allCompleted) return { status: "in_progress", details };

  const anyFailed = gating.some((c) => c.conclusion === "failure" || c.conclusion === "timed_out");
  return { status: anyFailed ? "failure" : "success", details };
}

export async function getFailedCheckLogs(
  token: string,
  owner: string,
  repo: string,
  branch: string
): Promise<string> {
  // Get the most recent workflow run for this branch
  const runsRes = await ghFetch(
    `${API}/repos/${owner}/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=1`,
    { headers: headers(token) }
  );
  if (!runsRes.ok) return "Could not fetch workflow runs.";
  const runsData = await runsRes.json();
  if (!runsData.workflow_runs?.length) return "No workflow runs found for this branch.";

  const run = runsData.workflow_runs[0];

  // Get jobs
  const jobsRes = await ghFetch(
    `${API}/repos/${owner}/${repo}/actions/runs/${run.id}/jobs`,
    { headers: headers(token) }
  );
  if (!jobsRes.ok) return `Run #${run.run_number}: ${run.conclusion ?? run.status}`;
  const jobsData = await jobsRes.json();

  const failedJobs = (jobsData.jobs ?? []).filter(
    (j: { conclusion: string }) => j.conclusion === "failure"
  );
  if (failedJobs.length === 0) return `Run #${run.run_number}: ${run.conclusion ?? run.status}`;

  const logs: string[] = [];
  for (const job of failedJobs) {
    logs.push(`--- Job: ${job.name} (FAILED) ---`);
    const failedSteps = (job.steps ?? []).filter(
      (s: { conclusion: string }) => s.conclusion === "failure"
    );
    for (const step of failedSteps) {
      logs.push(`  Step "${step.name}": FAILED`);
    }

    // Get annotations (contain actual error messages)
    const annRes = await ghFetch(
      `${API}/repos/${owner}/${repo}/check-runs/${job.id}/annotations`,
      { headers: headers(token) }
    );
    if (annRes.ok) {
      const annotations = await annRes.json();
      for (const ann of (annotations as { path: string; start_line: number; annotation_level: string; message: string }[])) {
        logs.push(`  ${ann.path}:${ann.start_line} [${ann.annotation_level}]: ${ann.message}`);
      }
    }
  }

  return logs.join("\n") || `CI failed (run #${run.run_number}) — no detailed logs available.`;
}

// ── Permission check ─────────────────────────────────────────────────────────

/**
 * Check if the GitHub token has write access to the repo.
 * Uses the repo endpoint which returns `permissions.push` for the authenticated user.
 */
export async function checkWritePermissions(
  token: string,
  owner: string,
  repo: string
): Promise<{ canPush: boolean; canPR: boolean; scopes: string | null }> {
  const res = await ghFetch(`${repoPath(owner, repo)}`, { headers: headers(token) });
  if (!res.ok) {
    return { canPush: false, canPR: false, scopes: res.headers.get("x-oauth-scopes") };
  }
  const data = await res.json();
  const perms = data.permissions ?? {};
  return {
    canPush: perms.push === true,
    canPR: perms.push === true || perms.pull === true, // PRs need at least pull + push
    scopes: res.headers.get("x-oauth-scopes"),
  };
}

// ── Pull Request operations ──────────────────────────────────────────────────

/**
 * Get the diff (patch) for a pull request.
 */
export async function getPRDiff(
  token: string,
  owner: string,
  repo: string,
  prNumber: number
): Promise<string> {
  const res = await ghFetch(`${API}/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: {
      ...headers(token),
      Accept: "application/vnd.github.v3.diff",
    },
  });
  if (!res.ok) throw new Error(`Failed to get PR diff (${res.status})`);
  return res.text();
}

/**
 * Get files changed in a pull request (file list with stats).
 */
export async function getPRFiles(
  token: string,
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ filename: string; status: string; additions: number; deletions: number; patch?: string }[]> {
  const res = await ghFetch(`${API}/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`, {
    headers: headers(token),
  });
  if (!res.ok) throw new Error(`Failed to get PR files (${res.status})`);
  const data = await res.json();
  return (data as { filename: string; status: string; additions: number; deletions: number; patch?: string }[]).map(
    (f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch })
  );
}

/**
 * Post a comment on a pull request (or issue).
 */
export async function commentOnPR(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  body: string
): Promise<void> {
  const res = await ghFetch(`${API}/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Failed to comment on PR (${res.status}): ${err}`);
  }
}

/**
 * Find an existing bot comment containing a hidden marker.
 */
export async function findBotComment(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  marker: string
): Promise<{ id: number } | null> {
  const res = await ghFetch(
    `${API}/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`,
    { headers: headers(token) }
  );
  if (!res.ok) return null;
  const comments = await res.json() as { id: number; body: string }[];
  const found = comments.find((c) => c.body.includes(marker));
  return found ? { id: found.id } : null;
}

/**
 * Update an existing issue/PR comment.
 */
export async function updatePRComment(
  token: string,
  owner: string,
  repo: string,
  commentId: number,
  body: string
): Promise<void> {
  const res = await ghFetch(`${API}/repos/${owner}/${repo}/issues/comments/${commentId}`, {
    method: "PATCH",
    headers: headers(token),
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`Failed to update comment (${res.status})`);
}

/**
 * Get pull request info.
 */
export async function getPRInfo(
  token: string,
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ title: string; body: string | null; head: string; base: string; user: string }> {
  const res = await ghFetch(`${API}/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: headers(token),
  });
  if (!res.ok) throw new Error(`Failed to get PR info (${res.status})`);
  const data = await res.json();
  return {
    title: data.title,
    body: data.body,
    head: data.head?.ref ?? "",
    base: data.base?.ref ?? "",
    user: data.user?.login ?? "",
  };
}

// ── Repo listing (fallback for repo detection) ──────────────────────────────

export async function listOwnerRepos(token: string, owner: string): Promise<string[]> {
  const res = await ghFetch(`${API}/users/${owner}/repos?per_page=100&sort=pushed`, {
    headers: headers(token),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data as { name: string }[]).map((r) => r.name);
}

// ── Deploy context ───────────────────────────────────────────────────────────

export type CommitFile = { filename: string; status: string; additions: number; deletions: number };

/** Get files changed in the most recent commit on a branch. */
export async function getRecentCommitFiles(
  token: string, owner: string, repo: string, branch: string
): Promise<{ sha: string; message: string; files: CommitFile[] } | null> {
  try {
    // Get latest commit on branch
    const commitsRes = await ghFetch(
      `${API}/repos/${owner}/${repo}/commits?sha=${branch}&per_page=1`,
      { headers: headers(token) }
    );
    if (!commitsRes.ok) return null;
    const commits = await commitsRes.json();
    if (!commits.length) return null;

    const sha = commits[0].sha as string;
    const message = (commits[0].commit?.message ?? "") as string;

    // Get files changed in that commit
    const detailRes = await ghFetch(
      `${API}/repos/${owner}/${repo}/commits/${sha}`,
      { headers: headers(token) }
    );
    if (!detailRes.ok) return null;
    const detail = await detailRes.json();

    const files: CommitFile[] = (detail.files ?? []).map((f: Record<string, unknown>) => ({
      filename: f.filename as string,
      status: (f.status ?? "modified") as string,
      additions: (f.additions ?? 0) as number,
      deletions: (f.deletions ?? 0) as number,
    }));

    return { sha, message, files };
  } catch {
    return null;
  }
}

/**
 * Fetch the unified diff for a specific commit. Used by the Preview Fix
 * feature's Tier 3 pipeline to give Claude enough context to predict the
 * post-fix UI. Returns `null` on any error — Tier 3 degrades gracefully
 * when the diff is unavailable.
 *
 * Diffs are capped at `maxBytes` (default 200 KB) — past that the signal
 * for a single-commit fix is noise and we'd rather truncate than feed the
 * model a giant binary-dump diff.
 */
export async function getCommitDiff(
  token: string,
  owner: string,
  repo: string,
  sha: string,
  maxBytes = 200 * 1024,
): Promise<string | null> {
  try {
    const res = await ghFetch(`${repoPath(owner, repo)}/commits/${encodeURIComponent(sha)}`, {
      headers: {
        ...headers(token),
        Accept: "application/vnd.github.v3.diff",
      },
    });
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > 0 && declared > maxBytes) {
      // Truncate reads to the budget; better to feed a partial diff than
      // to skip predictive context entirely.
      const text = await res.text();
      return text.slice(0, maxBytes) + `\n\n... (truncated at ${maxBytes} bytes)`;
    }
    const text = await res.text();
    if (text.length > maxBytes) {
      return text.slice(0, maxBytes) + `\n\n... (truncated at ${maxBytes} bytes)`;
    }
    return text;
  } catch {
    return null;
  }
}
