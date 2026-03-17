use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Deserialize;

use crate::config::SentryConfig;

// ── API types ─────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct SentryIssue {
    pub id: String,
    pub title: String,
    pub culprit: Option<String>,
    /// "error" | "warning" | "info" | "fatal"
    pub level: String,
    /// Sentry returns event count as a string — their API quirk
    #[serde(default)]
    pub count: String,
    #[serde(rename = "userCount")]
    pub user_count: u64,
    #[serde(rename = "firstSeen")]
    pub first_seen: DateTime<Utc>,
    #[serde(rename = "lastSeen")]
    pub last_seen: DateTime<Utc>,
    pub permalink: String,
    pub metadata: Option<IssueMetadata>,
}

impl SentryIssue {
    pub fn event_count(&self) -> u64 {
        self.count.parse().unwrap_or(0)
    }

    /// Severity mapped to our three-level system
    pub fn severity(&self) -> &'static str {
        match self.level.as_str() {
            "fatal" | "error" => "critical",
            "warning" => "warning",
            _ => "info",
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct IssueMetadata {
    pub value: Option<String>,
    pub filename: Option<String>,
    #[serde(rename = "type")]
    pub error_type: Option<String>,
}

// ── Client ────────────────────────────────────────────────────────────────────

pub struct SentryClient {
    client: reqwest::Client,
    token: String,
    org: String,
    project: String,
}

impl SentryClient {
    pub fn new(config: &SentryConfig) -> Self {
        Self {
            client: reqwest::Client::new(),
            token: config.token.clone(),
            org: config.org.clone(),
            project: config.project.clone(),
        }
    }

    async fn get<T: for<'de> serde::Deserialize<'de>>(&self, path: &str) -> Result<T> {
        let url = format!("https://sentry.io/api/0{}", path);
        let resp = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.token))
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("Sentry API {}: {} — {}", path, status, body);
        }

        Ok(resp.json::<T>().await?)
    }

    /// Verify the token and project exist. Returns the project name.
    pub async fn test_connection(&self) -> Result<String> {
        #[derive(Deserialize)]
        struct Project {
            name: String,
        }
        let p: Project = self
            .get(&format!("/projects/{}/{}/", self.org, self.project))
            .await?;
        Ok(p.name)
    }

    /// Issues first seen in the last `hours` hours (genuinely new errors).
    pub async fn get_new_issues(&self, hours: i64) -> Result<Vec<SentryIssue>> {
        let issues: Vec<SentryIssue> = self
            .get(&format!(
                "/projects/{}/{}/issues/?query=is:unresolved&sort=date&limit=50",
                self.org, self.project
            ))
            .await?;

        let cutoff = Utc::now() - chrono::Duration::hours(hours);
        Ok(issues
            .into_iter()
            .filter(|i| i.first_seen > cutoff)
            .collect())
    }

    /// Issues that have spiked in volume: seen > `min_events` times
    /// and the last occurrence was in the past `hours` hours.
    pub async fn get_spiking_issues(
        &self,
        hours: i64,
        min_events: u64,
    ) -> Result<Vec<SentryIssue>> {
        let issues: Vec<SentryIssue> = self
            .get(&format!(
                "/projects/{}/{}/issues/?query=is:unresolved&sort=events&limit=25",
                self.org, self.project
            ))
            .await?;

        let cutoff = Utc::now() - chrono::Duration::hours(hours);
        Ok(issues
            .into_iter()
            .filter(|i| i.event_count() >= min_events && i.last_seen > cutoff)
            .collect())
    }
}
