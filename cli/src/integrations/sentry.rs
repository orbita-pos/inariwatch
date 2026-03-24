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

    /// Get the latest event for an issue (includes stack trace).
    pub async fn get_issue_latest_event(&self, issue_id: &str) -> Result<Option<String>> {
        let path = format!(
            "/issues/{}/events/latest/",
            issue_id
        );

        let url = format!("https://sentry.io/api/0{}", path);
        let resp = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.token))
            .send()
            .await?;

        if resp.status().as_u16() == 404 {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Ok(None); // Gracefully skip if we can't get the event
        }

        let event: serde_json::Value = resp.json().await?;
        Ok(Some(Self::extract_stacktrace(&event)))
    }

    /// Extract a readable stack trace from a Sentry event JSON.
    fn extract_stacktrace(event: &serde_json::Value) -> String {
        let mut frames = Vec::new();

        // Navigate: entries[] -> { type: "exception", data: { values: [{ stacktrace: { frames } }] } }
        if let Some(entries) = event["entries"].as_array() {
            for entry in entries {
                if entry["type"].as_str() != Some("exception") {
                    continue;
                }
                if let Some(values) = entry["data"]["values"].as_array() {
                    for value in values {
                        let exc_type = value["type"].as_str().unwrap_or("Error");
                        let exc_value = value["value"].as_str().unwrap_or("");
                        frames.push(format!("{}: {}", exc_type, exc_value));

                        if let Some(trace_frames) = value["stacktrace"]["frames"].as_array() {
                            // Sentry frames are bottom-to-top; reverse for readability
                            for frame in trace_frames.iter().rev().take(15) {
                                let filename = frame["filename"].as_str().unwrap_or("?");
                                let lineno = frame["lineNo"]
                                    .as_u64()
                                    .or_else(|| frame["lineno"].as_u64())
                                    .map(|n| n.to_string())
                                    .unwrap_or_else(|| "?".to_string());
                                let function = frame["function"].as_str().unwrap_or("?");
                                let context_line = frame["contextLine"]
                                    .as_str()
                                    .or_else(|| frame["context_line"].as_str())
                                    .unwrap_or("");
                                frames.push(format!("  at {} ({}:{})", function, filename, lineno));
                                if !context_line.is_empty() {
                                    frames.push(format!("    > {}", context_line.trim()));
                                }
                            }
                        }
                    }
                }
            }
        }

        if frames.is_empty() {
            // Fallback: try top-level message
            event["message"]
                .as_str()
                .or_else(|| event["title"].as_str())
                .unwrap_or("No stack trace available")
                .to_string()
        } else {
            frames.join("\n")
        }
    }

    /// Get summary details for a specific issue by ID. Returns None on 404.
    pub async fn get_issue_details(&self, issue_id: &str) -> Result<Option<String>> {
        #[derive(Deserialize)]
        struct IssueDetail {
            title: String,
            level: String,
            status: String,
            count: String,
            #[serde(rename = "userCount")]
            user_count: u64,
            culprit: Option<String>,
        }

        let path = format!("/issues/{}/", issue_id);
        let url = format!("https://sentry.io/api/0{}", path);
        let resp = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.token))
            .send()
            .await?;

        if resp.status().as_u16() == 404 {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Ok(None); // Gracefully skip
        }

        let detail: IssueDetail = match resp.json().await {
            Ok(d) => d,
            Err(_) => return Ok(None),
        };

        let culprit_line = detail
            .culprit
            .as_deref()
            .map(|c| format!("\nCulprit: {}", c))
            .unwrap_or_default();

        Ok(Some(format!(
            "Issue: {}\nLevel: {} | Status: {} | Events: {} | Users: {}{}",
            detail.title,
            detail.level,
            detail.status,
            detail.count,
            detail.user_count,
            culprit_line,
        )))
    }

    /// Issues first seen after `since` (used for regression detection).
    pub async fn get_issues_since(&self, since: DateTime<Utc>) -> Result<Vec<SentryIssue>> {
        #[derive(Deserialize)]
        struct RegressionIssue {
            id: String,
            title: String,
            culprit: Option<String>,
            level: String,
            #[serde(default)]
            count: String,
            #[serde(rename = "userCount")]
            user_count: u64,
            #[serde(rename = "firstSeen")]
            first_seen: DateTime<Utc>,
            #[serde(rename = "lastSeen")]
            last_seen: DateTime<Utc>,
            permalink: String,
            metadata: Option<IssueMetadata>,
            #[serde(rename = "isRegression", default)]
            is_regression: bool,
        }

        impl From<RegressionIssue> for SentryIssue {
            fn from(r: RegressionIssue) -> Self {
                SentryIssue {
                    id: r.id,
                    title: r.title,
                    culprit: r.culprit,
                    level: r.level,
                    count: r.count,
                    user_count: r.user_count,
                    first_seen: r.first_seen,
                    last_seen: r.last_seen,
                    permalink: r.permalink,
                    metadata: r.metadata,
                }
            }
        }

        let url = format!(
            "https://sentry.io/api/0/projects/{}/{}/issues/?query=is:unresolved&sort=date&limit=20",
            self.org, self.project
        );
        let resp = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.token))
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("Sentry API issues: {} — {}", status, body);
        }

        let raw: Vec<RegressionIssue> = resp.json().await?;
        Ok(raw
            .into_iter()
            .filter(|i| i.first_seen > since || i.is_regression)
            .map(SentryIssue::from)
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
