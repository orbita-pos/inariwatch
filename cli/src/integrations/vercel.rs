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
