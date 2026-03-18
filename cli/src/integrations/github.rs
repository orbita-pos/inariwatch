use anyhow::Result;
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
}
