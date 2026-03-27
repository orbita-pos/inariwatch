/**
 * GitHub REST API service for AI remediation.
 * Handles: reading files, creating branches, committing, creating PRs, checking CI status.
 */

const API = "https://api.github.com";

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "InariWatch-Remediation/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// ── Repo info ────────────────────────────────────────────────────────────────

export async function getDefaultBranch(token: string, owner: string, repo: string): Promise<string> {
  const res = await fetch(`${API}/repos/${owner}/${repo}`, { headers: headers(token) });
  if (!res.ok) throw new Error(`Failed to get repo info (${res.status})`);
  const data = await res.json();
  return data.default_branch ?? "main";
}

export async function getBranchSha(token: string, owner: string, repo: string, branch: string): Promise<string> {
  const res = await fetch(`${API}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, {
    headers: headers(token),
  });
  if (!res.ok) throw new Error(`Failed to get branch SHA (${res.status})`);
  const data = await res.json();
  return data.object.sha;
}

export async function getRepoTree(token: string, owner: string, repo: string, ref: string): Promise<string[]> {
  const res = await fetch(`${API}/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, {
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
  const res = await fetch(url, { headers: headers(token) });
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
  const res = await fetch(`${API}/repos/${owner}/${repo}/git/refs`, {
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
  const commitRes = await fetch(`${API}/repos/${owner}/${repo}/git/commits/${branchSha}`, { headers: h });
  if (!commitRes.ok) throw new Error(`Failed to get commit (${commitRes.status})`);
  const commitData = await commitRes.json();
  const baseTreeSha = commitData.tree.sha;

  // 3. Create blobs
  const tree = await Promise.all(
    files.map(async (f) => {
      const blobRes = await fetch(`${API}/repos/${owner}/${repo}/git/blobs`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ content: f.content, encoding: "utf-8" }),
      });
      if (!blobRes.ok) throw new Error(`Failed to create blob for ${f.path} (${blobRes.status})`);
      const blob = await blobRes.json();
      return { path: f.path, mode: "100644" as const, type: "blob" as const, sha: blob.sha as string };
    })
  );

  // 4. Create new tree
  const treeRes = await fetch(`${API}/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ base_tree: baseTreeSha, tree }),
  });
  if (!treeRes.ok) throw new Error(`Failed to create tree (${treeRes.status})`);
  const treeData = await treeRes.json();

  // 5. Create commit
  const newCommitRes = await fetch(`${API}/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ message, tree: treeData.sha, parents: [branchSha] }),
  });
  if (!newCommitRes.ok) throw new Error(`Failed to create commit (${newCommitRes.status})`);
  const newCommit = await newCommitRes.json();

  // 6. Update branch ref
  const updateRes = await fetch(`${API}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
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
  const res = await fetch(`${API}/repos/${owner}/${repo}/pulls`, {
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
  const res = await fetch(`${API}/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
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

export async function getCheckRunsStatus(
  token: string,
  owner: string,
  repo: string,
  ref: string
): Promise<{ status: CIStatus; details: CheckDetail[] }> {
  const res = await fetch(`${API}/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=100`, {
    headers: headers(token),
  });
  if (!res.ok) throw new Error(`Failed to get check runs (${res.status})`);
  const data = await res.json();

  if (data.total_count === 0) return { status: "pending", details: [] };

  const checks = data.check_runs as { name: string; status: string; conclusion: string | null }[];
  const details = checks.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion }));

  const allCompleted = checks.every((c) => c.status === "completed");
  if (!allCompleted) return { status: "in_progress", details };

  const anyFailed = checks.some((c) => c.conclusion === "failure" || c.conclusion === "timed_out");
  return { status: anyFailed ? "failure" : "success", details };
}

export async function getFailedCheckLogs(
  token: string,
  owner: string,
  repo: string,
  branch: string
): Promise<string> {
  // Get the most recent workflow run for this branch
  const runsRes = await fetch(
    `${API}/repos/${owner}/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=1`,
    { headers: headers(token) }
  );
  if (!runsRes.ok) return "Could not fetch workflow runs.";
  const runsData = await runsRes.json();
  if (!runsData.workflow_runs?.length) return "No workflow runs found for this branch.";

  const run = runsData.workflow_runs[0];

  // Get jobs
  const jobsRes = await fetch(
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
    const annRes = await fetch(
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
  const res = await fetch(`${API}/repos/${owner}/${repo}`, { headers: headers(token) });
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
  const res = await fetch(`${API}/repos/${owner}/${repo}/pulls/${prNumber}`, {
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
  const res = await fetch(`${API}/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`, {
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
  const res = await fetch(`${API}/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
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
  const res = await fetch(
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
  const res = await fetch(`${API}/repos/${owner}/${repo}/issues/comments/${commentId}`, {
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
  const res = await fetch(`${API}/repos/${owner}/${repo}/pulls/${prNumber}`, {
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
  const res = await fetch(`${API}/users/${owner}/repos?per_page=100&sort=pushed`, {
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
    const commitsRes = await fetch(
      `${API}/repos/${owner}/${repo}/commits?sha=${branch}&per_page=1`,
      { headers: headers(token) }
    );
    if (!commitsRes.ok) return null;
    const commits = await commitsRes.json();
    if (!commits.length) return null;

    const sha = commits[0].sha as string;
    const message = (commits[0].commit?.message ?? "") as string;

    // Get files changed in that commit
    const detailRes = await fetch(
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
