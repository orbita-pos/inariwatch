use anyhow::Result;
use chrono::{DateTime, TimeZone, Utc};
use serde::Deserialize;

use crate::config::VercelConfig;

// ── API types ─────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct Deployment {
    pub uid: String,
    pub name: String,
    pub url: Option<String>,
    pub state: Option<String>,
    /// Vercel sends milliseconds since epoch
    #[serde(rename = "createdAt")]
    pub created_at_ms: i64,
    pub meta: Option<DeploymentMeta>,
}

impl Deployment {
    pub fn created_at(&self) -> DateTime<Utc> {
        Utc.timestamp_millis_opt(self.created_at_ms)
            .single()
            .unwrap_or_else(Utc::now)
    }
}

#[derive(Debug, Deserialize)]
pub struct DeploymentMeta {
    #[serde(rename = "githubCommitMessage")]
    pub commit_message: Option<String>,
    #[serde(rename = "githubCommitRef")]
    pub branch: Option<String>,
    #[serde(rename = "githubCommitSha")]
    pub commit_sha: Option<String>,
    #[serde(rename = "githubCommitAuthorName")]
    pub author: Option<String>,
    #[serde(rename = "githubPrId")]
    pub pr_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DeploymentsResponse {
    deployments: Vec<Deployment>,
}

#[derive(Debug, Deserialize)]
struct DeploymentEvent {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    level: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
}

// ── Client ────────────────────────────────────────────────────────────────────

pub struct VercelClient {
    client: reqwest::Client,
    token: String,
    team_id: Option<String>,
}

impl VercelClient {
    pub fn new(config: &VercelConfig) -> Self {
        Self {
            client: reqwest::Client::new(),
            token: config.token.clone(),
            team_id: config.team_id.clone(),
        }
    }

    pub fn with_token(token: &str, team_id: Option<String>) -> Self {
        Self {
            client: reqwest::Client::new(),
            token: token.to_string(),
            team_id,
        }
    }

    fn team_qs(&self) -> String {
        self.team_id
            .as_ref()
            .map(|id| format!("teamId={}&", id))
            .unwrap_or_default()
    }

    async fn get<T: for<'de> serde::Deserialize<'de>>(&self, path: &str) -> Result<T> {
        let url = format!("https://api.vercel.com{}", path);
        let resp = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.token))
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("Vercel API {}: {} — {}", path, status, body);
        }

        Ok(resp.json::<T>().await?)
    }

    /// Resolve a project by name or ID and return it.
    pub async fn get_project(&self, id_or_name: &str) -> Result<Project> {
        let qs = self.team_qs();
        let sep = if qs.is_empty() { "" } else { "?" };
        self.get(&format!(
            "/v9/projects/{}{}{}",
            id_or_name,
            sep,
            qs.trim_end_matches('&')
        ))
        .await
    }

    /// Most recent successful (READY) deployments for a project.
    pub async fn get_recent_ready_deployments(
        &self,
        project_id: &str,
        limit: usize,
    ) -> Result<Vec<Deployment>> {
        let qs = self.team_qs();
        let path = format!(
            "/v6/deployments?{}projectId={}&limit={}&state=READY",
            qs, project_id, limit
        );
        let resp: DeploymentsResponse = self.get(&path).await?;
        Ok(resp.deployments)
    }

    /// Rollback: re-promote an existing READY deployment to production.
    ///
    /// Uses the deployment creation endpoint with `deploymentId` to create
    /// a production copy of a previous deployment (documented Vercel API).
    pub async fn rollback_to(&self, project_id: &str, target_id: &str) -> Result<()> {
        let qs = self.team_qs();
        let qs_str = if qs.is_empty() {
            String::new()
        } else {
            format!("?{}", qs.trim_end_matches('&'))
        };
        let url = format!(
            "https://api.vercel.com/v13/deployments{}",
            qs_str
        );
        let resp = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.token))
            .json(&serde_json::json!({
                "deploymentId": target_id,
                "name": project_id,
                "target": "production"
            }))
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!(
                "Vercel API returned {} — {}\n\n\
                 Fallback: install the Vercel CLI and run:\n  \
                 vercel rollback {}",
                status, body, target_id
            );
        }
        Ok(())
    }

    /// Fetch build log events for a specific deployment.
    /// Returns (log_text, error_summary).
    pub async fn get_deployment_events(
        &self,
        deployment_id: &str,
    ) -> Result<(String, String)> {
        let qs = self.team_qs();
        let path = format!(
            "/v3/deployments/{}/events?{}direction=backward&limit=200",
            deployment_id, qs
        );

        let events: Vec<DeploymentEvent> = self.get(&path).await?;

        let mut lines: Vec<String> = Vec::new();
        let mut error_lines: Vec<String> = Vec::new();

        for event in &events {
            let text = event.text.as_deref().unwrap_or("");
            if text.is_empty() {
                continue;
            }
            lines.push(text.to_string());

            // Collect error-level lines
            let is_error = event.level.as_deref() == Some("error")
                || text.contains("Error:")
                || text.contains("error[")
                || text.contains("FATAL")
                || text.contains("Module not found")
                || text.contains("Cannot find module")
                || text.contains("Build failed");

            if is_error {
                error_lines.push(text.to_string());
            }
        }

        // Reverse since we fetched backward
        lines.reverse();
        error_lines.reverse();

        let full_log = if lines.len() > 100 {
            // Keep last 100 lines
            lines[lines.len() - 100..].join("\n")
        } else {
            lines.join("\n")
        };

        let error_summary = if error_lines.is_empty() {
            "No explicit error lines found in build logs.".to_string()
        } else {
            error_lines.join("\n")
        };

        Ok((full_log, error_summary))
    }

    /// Deployments in ERROR state created in the last `hours` hours.
    pub async fn get_failed_deployments(
        &self,
        project_id: &str,
        hours: i64,
    ) -> Result<Vec<Deployment>> {
        let qs = self.team_qs();
        let path = format!(
            "/v6/deployments?{}projectId={}&limit=20&state=ERROR",
            qs, project_id
        );
        let resp: DeploymentsResponse = self.get(&path).await?;
        let cutoff = Utc::now() - chrono::Duration::hours(hours);
        Ok(resp
            .deployments
            .into_iter()
            .filter(|d| d.created_at() > cutoff)
            .collect())
    }
}
