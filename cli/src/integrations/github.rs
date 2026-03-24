use anyhow::Result;
use base64::Engine;
use chrono::{DateTime, Utc};
use serde::Deserialize;

use crate::config::GithubConfig;

// ── API types ─────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub html_url: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub user: GithubUser,
    pub draft: bool,
    #[serde(default)]
    pub requested_reviewers: Vec<GithubUser>,
}

#[derive(Debug, Deserialize)]
pub struct GithubUser {
    pub login: String,
}

#[derive(Debug, Deserialize)]
pub struct WorkflowRun {
    pub id: u64,
    pub name: Option<String>,
    pub html_url: String,
    pub conclusion: Option<String>,
    pub created_at: DateTime<Utc>,
    pub head_branch: Option<String>,
    pub head_commit: Option<HeadCommit>,
}

#[derive(Debug, Deserialize)]
pub struct HeadCommit {
    pub message: String,
    pub author: CommitAuthor,
}

#[derive(Debug, Deserialize)]
pub struct CommitAuthor {
    pub name: String,
}

#[derive(Debug, Deserialize)]
struct WorkflowRunsResponse {
    workflow_runs: Vec<WorkflowRun>,
}

// ── v2 types ─────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct TreeEntry {
    path: String,
    #[serde(rename = "type")]
    entry_type: String,
    #[serde(default)]
    size: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct TreeResponse {
    #[serde(default)]
    tree: Vec<TreeEntry>,
}

#[derive(Debug, Deserialize)]
struct ContentResponse {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    encoding: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RefResponse {
    object: RefObject,
}

#[derive(Debug, Deserialize)]
struct RefObject {
    sha: String,
}

#[derive(Debug, Deserialize)]
struct CommitResponse {
    sha: String,
    tree: TreeRef,
}

#[derive(Debug, Deserialize)]
struct TreeRef {
    sha: String,
}

#[derive(Debug, Deserialize)]
struct BlobResponse {
    sha: String,
}

#[derive(Debug, Deserialize)]
struct CreateTreeResponse {
    sha: String,
}

#[derive(Debug, Deserialize)]
struct CreateCommitResponse {
    sha: String,
}

#[derive(Debug, Deserialize)]
struct PRCreateResponse {
    html_url: String,
    number: u64,
}

#[derive(Debug, Deserialize)]
struct MergeResponse {
    #[serde(default)]
    sha: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RepoInfoResponse {
    default_branch: Option<String>,
    #[serde(default)]
    permissions: RepoPermissions,
}

#[derive(Debug, Deserialize, Default)]
struct RepoPermissions {
    #[serde(default)]
    push: bool,
    #[serde(default)]
    pull: bool,
}

#[derive(Debug)]
pub struct CheckRunsStatus {
    pub status: CIStatus,
    pub details: Vec<CheckDetail>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CIStatus {
    Pending,
    Success,
    Failure,
    InProgress,
}

#[derive(Debug)]
pub struct CheckDetail {
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
}

// ── Client ────────────────────────────────────────────────────────────────────

pub struct GitHubClient {
    client: reqwest::Client,
    token: String,
    pub repo: String,
}

impl GitHubClient {
    pub fn new(config: &GithubConfig) -> Self {
        Self {
            client: reqwest::Client::new(),
            token: config.token.clone(),
            repo: config.repo.clone(),
        }
    }

    fn owner_repo(&self) -> (&str, &str) {
        self.repo.split_once('/').unwrap_or(("", &self.repo))
    }

    async fn get<T: for<'de> serde::Deserialize<'de>>(&self, path: &str) -> Result<T> {
        let url = format!("https://api.github.com{}", path);
        let resp = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.token))
            .header("User-Agent", "inariwatch-cli/0.1.0")
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("GitHub API {} — {}: {}", path, status, body);
        }

        Ok(resp.json::<T>().await?)
    }

    async fn post<T: for<'de> serde::Deserialize<'de>>(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<T> {
        let url = format!("https://api.github.com{}", path);
        let resp = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.token))
            .header("User-Agent", "inariwatch-cli/0.1.0")
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .json(body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body_text = resp.text().await.unwrap_or_default();
            anyhow::bail!("GitHub API POST {} — {}: {}", path, status, body_text);
        }

        Ok(resp.json::<T>().await?)
    }

    async fn put<T: for<'de> serde::Deserialize<'de>>(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<T> {
        let url = format!("https://api.github.com{}", path);
        let resp = self
            .client
            .put(&url)
            .header("Authorization", format!("Bearer {}", self.token))
            .header("User-Agent", "inariwatch-cli/0.1.0")
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .json(body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body_text = resp.text().await.unwrap_or_default();
            anyhow::bail!("GitHub API PUT {} — {}: {}", path, status, body_text);
        }

        Ok(resp.json::<T>().await?)
    }

    async fn patch_raw(&self, path: &str, body: &serde_json::Value) -> Result<()> {
        let url = format!("https://api.github.com{}", path);
        let resp = self
            .client
            .patch(&url)
            .header("Authorization", format!("Bearer {}", self.token))
            .header("User-Agent", "inariwatch-cli/0.1.0")
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .json(body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body_text = resp.text().await.unwrap_or_default();
            anyhow::bail!("GitHub API PATCH {} — {}: {}", path, status, body_text);
        }
        Ok(())
    }

    // ── v1 read operations ──────────────────────────────────────────────────

    /// Verify the token and repo are valid. Returns the full repo name.
    pub async fn test_connection(&self) -> Result<String> {
        #[derive(Deserialize)]
        struct Repo {
            full_name: String,
        }
        let repo: Repo = self.get(&format!("/repos/{}", self.repo)).await?;
        Ok(repo.full_name)
    }

    /// Open PRs that haven't been updated in `days` days and are not drafts.
    pub async fn get_stale_prs(&self, days: u64) -> Result<Vec<PullRequest>> {
        let prs: Vec<PullRequest> = self
            .get(&format!(
                "/repos/{}/pulls?state=open&per_page=100",
                self.repo
            ))
            .await?;

        let threshold = Utc::now() - chrono::Duration::days(days as i64);
        Ok(prs
            .into_iter()
            .filter(|pr| !pr.draft && pr.updated_at < threshold)
            .collect())
    }

    /// Most recent failed CI runs (up to `limit`), within the last 6 hours.
    pub async fn get_recent_failures(&self, limit: u32) -> Result<Vec<WorkflowRun>> {
        let resp: WorkflowRunsResponse = self
            .get(&format!(
                "/repos/{}/actions/runs?status=failure&per_page={}",
                self.repo, limit
            ))
            .await?;

        let cutoff = Utc::now() - chrono::Duration::hours(6);
        Ok(resp
            .workflow_runs
            .into_iter()
            .filter(|r| r.created_at > cutoff)
            .collect())
    }

    // ── v2 read operations ──────────────────────────────────────────────────

    /// Get the default branch name (usually "main" or "master").
    pub async fn get_default_branch(&self) -> Result<String> {
        let info: RepoInfoResponse = self.get(&format!("/repos/{}", self.repo)).await?;
        Ok(info.default_branch.unwrap_or_else(|| "main".to_string()))
    }

    /// Get the SHA of a branch tip.
    pub async fn get_branch_sha(&self, branch: &str) -> Result<String> {
        let r: RefResponse = self
            .get(&format!("/repos/{}/git/ref/heads/{}", self.repo, branch))
            .await?;
        Ok(r.object.sha)
    }

    /// Get the full file tree of a ref (recursive). Filters out large files.
    pub async fn get_repo_tree(&self, git_ref: &str) -> Result<Vec<String>> {
        let resp: TreeResponse = self
            .get(&format!(
                "/repos/{}/git/trees/{}?recursive=1",
                self.repo, git_ref
            ))
            .await?;
        Ok(resp
            .tree
            .into_iter()
            .filter(|e| e.entry_type == "blob" && e.size.unwrap_or(0) < 500_000)
            .map(|e| e.path)
            .collect())
    }

    /// Get the content of a single file. Returns None for 404.
    pub async fn get_file_content(&self, path: &str, git_ref: Option<&str>) -> Result<Option<String>> {
        let (owner, repo) = self.owner_repo();
        let encoded_path = urlencoding::encode(path);
        let ref_qs = git_ref
            .map(|r| format!("?ref={}", urlencoding::encode(r)))
            .unwrap_or_default();

        let url = format!(
            "https://api.github.com/repos/{}/{}/contents/{}{}",
            owner, repo, encoded_path, ref_qs
        );

        let resp = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.token))
            .header("User-Agent", "inariwatch-cli/0.1.0")
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()
            .await?;

        if resp.status().as_u16() == 404 {
            return Ok(None);
        }
        if !resp.status().is_success() {
            anyhow::bail!("Failed to read {} ({})", path, resp.status());
        }

        let data: ContentResponse = resp.json().await?;
        if data.encoding.as_deref() == Some("base64") {
            if let Some(content) = &data.content {
                let cleaned: String = content.chars().filter(|c| !c.is_whitespace()).collect();
                let bytes = base64::engine::general_purpose::STANDARD.decode(&cleaned)?;
                return Ok(Some(String::from_utf8(bytes)?));
            }
        }
        Ok(data.content)
    }

    /// Check if the token has write (push) access to the repo.
    pub async fn check_write_permissions(&self) -> Result<bool> {
        let info: RepoInfoResponse = self.get(&format!("/repos/{}", self.repo)).await?;
        Ok(info.permissions.push)
    }

    // ── v2 write operations ─────────────────────────────────────────────────

    /// Create a new branch from a base SHA.
    pub async fn create_branch(&self, name: &str, sha: &str) -> Result<()> {
        let _: serde_json::Value = self
            .post(
                &format!("/repos/{}/git/refs", self.repo),
                &serde_json::json!({
                    "ref": format!("refs/heads/{}", name),
                    "sha": sha
                }),
            )
            .await?;
        Ok(())
    }

    /// Commit files to a branch using the Git Tree API.
    /// Returns the new commit SHA.
    pub async fn commit_files(
        &self,
        branch: &str,
        message: &str,
        files: &[(&str, &str)], // (path, content)
    ) -> Result<String> {
        // 1. Get current branch SHA
        let branch_sha = self.get_branch_sha(branch).await?;

        // 2. Get base tree SHA
        let commit: CommitResponse = self
            .get(&format!("/repos/{}/git/commits/{}", self.repo, branch_sha))
            .await?;
        let base_tree_sha = commit.tree.sha;

        // 3. Create blobs and build tree entries
        let mut tree_entries = Vec::new();
        for (path, content) in files {
            let blob: BlobResponse = self
                .post(
                    &format!("/repos/{}/git/blobs", self.repo),
                    &serde_json::json!({
                        "content": content,
                        "encoding": "utf-8"
                    }),
                )
                .await?;
            tree_entries.push(serde_json::json!({
                "path": path,
                "mode": "100644",
                "type": "blob",
                "sha": blob.sha
            }));
        }

        // 4. Create new tree
        let new_tree: CreateTreeResponse = self
            .post(
                &format!("/repos/{}/git/trees", self.repo),
                &serde_json::json!({
                    "base_tree": base_tree_sha,
                    "tree": tree_entries
                }),
            )
            .await?;

        // 5. Create commit
        let new_commit: CreateCommitResponse = self
            .post(
                &format!("/repos/{}/git/commits", self.repo),
                &serde_json::json!({
                    "message": message,
                    "tree": new_tree.sha,
                    "parents": [branch_sha]
                }),
            )
            .await?;

        // 6. Update branch ref
        self.patch_raw(
            &format!("/repos/{}/git/refs/heads/{}", self.repo, branch),
            &serde_json::json!({ "sha": new_commit.sha }),
        )
        .await?;

        Ok(new_commit.sha)
    }

    /// Create a pull request. Returns (html_url, pr_number).
    pub async fn create_pr(
        &self,
        title: &str,
        body: &str,
        head: &str,
        base: &str,
        draft: bool,
    ) -> Result<(String, u64)> {
        let pr: PRCreateResponse = self
            .post(
                &format!("/repos/{}/pulls", self.repo),
                &serde_json::json!({
                    "title": title,
                    "body": body,
                    "head": head,
                    "base": base,
                    "draft": draft
                }),
            )
            .await?;
        Ok((pr.html_url, pr.number))
    }

    /// Create a revert branch that points the tree back to the parent of `merge_sha`.
    /// Returns the new commit SHA.
    pub async fn create_revert_branch(
        &self,
        merge_sha: &str,
        branch_name: &str,
        message: &str,
    ) -> anyhow::Result<String> {
        #[derive(Deserialize)]
        struct CommitDetail {
            parents: Vec<CommitRef>,
            tree: CommitRef,
        }
        #[derive(Deserialize)]
        struct CommitRef {
            sha: String,
        }

        // 1. Get the merge commit to find its parent
        let merge_commit: CommitDetail = self
            .get(&format!("/repos/{}/git/commits/{}", self.repo, merge_sha))
            .await?;

        let parent_sha = merge_commit
            .parents
            .first()
            .ok_or_else(|| anyhow::anyhow!("Merge commit {} has no parents", merge_sha))?
            .sha
            .clone();

        // 2. Get the parent commit to find its tree
        let parent_commit: CommitDetail = self
            .get(&format!("/repos/{}/git/commits/{}", self.repo, parent_sha))
            .await?;
        let parent_tree_sha = parent_commit.tree.sha;

        // 3. Create a new commit with the parent's tree, pointing back at the merge commit
        let new_commit: CreateCommitResponse = self
            .post(
                &format!("/repos/{}/git/commits", self.repo),
                &serde_json::json!({
                    "message": message,
                    "tree": parent_tree_sha,
                    "parents": [merge_sha]
                }),
            )
            .await?;

        // 4. Create the branch pointing at the new commit
        let _: serde_json::Value = self
            .post(
                &format!("/repos/{}/git/refs", self.repo),
                &serde_json::json!({
                    "ref": format!("refs/heads/{}", branch_name),
                    "sha": new_commit.sha
                }),
            )
            .await?;

        Ok(new_commit.sha)
    }

    /// Squash-merge a pull request. Returns the merge commit SHA.
    pub async fn merge_pr(&self, pr_number: u64) -> Result<String> {
        let resp: MergeResponse = self
            .put(
                &format!("/repos/{}/pulls/{}/merge", self.repo, pr_number),
                &serde_json::json!({ "merge_method": "squash" }),
            )
            .await?;
        Ok(resp.sha.unwrap_or_default())
    }

    // ── v2 CI status ────────────────────────────────────────────────────────

    /// Get the check runs status for a commit ref.
    pub async fn get_check_runs_status(&self, git_ref: &str) -> Result<CheckRunsStatus> {
        #[derive(Deserialize)]
        struct CheckRunsResponse {
            total_count: u64,
            #[serde(default)]
            check_runs: Vec<CheckRun>,
        }
        #[derive(Deserialize)]
        struct CheckRun {
            name: String,
            status: String,
            conclusion: Option<String>,
        }

        let resp: CheckRunsResponse = self
            .get(&format!(
                "/repos/{}/commits/{}/check-runs?per_page=100",
                self.repo, git_ref
            ))
            .await?;

        if resp.total_count == 0 {
            return Ok(CheckRunsStatus {
                status: CIStatus::Pending,
                details: vec![],
            });
        }

        let details: Vec<CheckDetail> = resp
            .check_runs
            .iter()
            .map(|c| CheckDetail {
                name: c.name.clone(),
                status: c.status.clone(),
                conclusion: c.conclusion.clone(),
            })
            .collect();

        let all_completed = resp.check_runs.iter().all(|c| c.status == "completed");
        if !all_completed {
            return Ok(CheckRunsStatus {
                status: CIStatus::InProgress,
                details,
            });
        }

        let any_failed = resp
            .check_runs
            .iter()
            .any(|c| matches!(c.conclusion.as_deref(), Some("failure") | Some("timed_out")));

        Ok(CheckRunsStatus {
            status: if any_failed {
                CIStatus::Failure
            } else {
                CIStatus::Success
            },
            details,
        })
    }

    /// Get logs from the most recent failed CI run on a branch.
    pub async fn get_failed_check_logs(&self, branch: &str) -> Result<String> {
        #[derive(Deserialize)]
        struct RunsResp {
            #[serde(default)]
            workflow_runs: Vec<RunInfo>,
        }
        #[derive(Deserialize)]
        struct RunInfo {
            id: u64,
            run_number: u64,
            conclusion: Option<String>,
            status: Option<String>,
        }
        #[derive(Deserialize)]
        struct JobsResp {
            #[serde(default)]
            jobs: Vec<Job>,
        }
        #[derive(Deserialize)]
        struct Job {
            id: u64,
            name: String,
            conclusion: Option<String>,
            #[serde(default)]
            steps: Vec<Step>,
        }
        #[derive(Deserialize)]
        struct Step {
            name: String,
            conclusion: Option<String>,
        }
        #[derive(Deserialize)]
        struct Annotation {
            path: String,
            start_line: u64,
            annotation_level: String,
            message: String,
        }

        let runs: RunsResp = self
            .get(&format!(
                "/repos/{}/actions/runs?branch={}&per_page=1",
                self.repo, branch
            ))
            .await?;

        let run = match runs.workflow_runs.first() {
            Some(r) => r,
            None => return Ok("No workflow runs found for this branch.".to_string()),
        };

        let jobs: JobsResp = self
            .get(&format!(
                "/repos/{}/actions/runs/{}/jobs",
                self.repo, run.id
            ))
            .await?;

        let failed_jobs: Vec<&Job> = jobs
            .jobs
            .iter()
            .filter(|j| j.conclusion.as_deref() == Some("failure"))
            .collect();

        if failed_jobs.is_empty() {
            return Ok(format!(
                "Run #{}: {}",
                run.run_number,
                run.conclusion
                    .as_deref()
                    .or(run.status.as_deref())
                    .unwrap_or("unknown")
            ));
        }

        let mut logs = Vec::new();
        for job in &failed_jobs {
            logs.push(format!("--- Job: {} (FAILED) ---", job.name));
            for step in &job.steps {
                if step.conclusion.as_deref() == Some("failure") {
                    logs.push(format!("  Step \"{}\": FAILED", step.name));
                }
            }

            // Get annotations
            if let Ok(annotations) = self
                .get::<Vec<Annotation>>(&format!(
                    "/repos/{}/check-runs/{}/annotations",
                    self.repo, job.id
                ))
                .await
            {
                for ann in annotations {
                    logs.push(format!(
                        "  {}:{} [{}]: {}",
                        ann.path, ann.start_line, ann.annotation_level, ann.message
                    ));
                }
            }
        }

        if logs.is_empty() {
            Ok(format!(
                "CI failed (run #{}) — no detailed logs available.",
                run.run_number
            ))
        } else {
            Ok(logs.join("\n"))
        }
    }
}
