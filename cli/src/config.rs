use anyhow::{Context, Result};
use dirs::config_dir;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ── Top-level config ─────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Config {
    #[serde(default)]
    pub global: GlobalConfig,
    #[serde(default)]
    pub projects: Vec<ProjectConfig>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct GlobalConfig {
    pub ai_key: Option<String>,
    #[serde(default = "default_model")]
    pub ai_model: String,
    /// Automatically trigger AI fix pipeline when a critical alert is detected.
    #[serde(default)]
    pub auto_fix: bool,
    /// Auto-merge the generated PR when all safety gates pass (requires auto_fix = true).
    #[serde(default)]
    pub auto_merge: bool,
    /// Enable Fix Replay: query shared community patterns for known fixes before AI diagnosis.
    #[serde(default)]
    pub fix_replay: bool,
    /// InariWatch web API URL for Fix Replay pattern queries (e.g. "https://app.inariwatch.com").
    pub fix_replay_url: Option<String>,
}

impl Default for GlobalConfig {
    fn default() -> Self {
        Self {
            ai_key: None,
            ai_model: default_model(),
            auto_fix: false,
            auto_merge: false,
            fix_replay: false,
            fix_replay_url: None,
        }
    }
}

fn default_model() -> String {
    "claude-haiku-4-5-20251001".to_string()
}

// ── Project ───────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
pub struct ProjectConfig {
    pub name: String,
    pub slug: String,
    pub path: Option<String>,
    #[serde(default)]
    pub integrations: Integrations,
    #[serde(default)]
    pub notifications: Notifications,
}

// ── Integrations ──────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Integrations {
    pub github: Option<GithubConfig>,
    pub vercel: Option<VercelConfig>,
    pub sentry: Option<SentryConfig>,
    pub git: Option<GitConfig>,
    pub capture: Option<CaptureConfig>,
    pub uptime: Option<UptimeConfig>,
    pub cron: Option<CronConfig>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct GithubConfig {
    pub token: String,
    /// "owner/repo"
    pub repo: String,
    #[serde(default = "default_stale_days")]
    pub stale_pr_days: u64,
}

fn default_stale_days() -> u64 {
    2
}

#[derive(Serialize, Deserialize, Clone)]
pub struct VercelConfig {
    pub token: String,
    pub project_id: String,
    pub team_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SentryConfig {
    pub token: String,
    pub org: String,
    pub project: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct GitConfig {
    /// Path to the repo root (defaults to the project `path`)
    pub path: Option<String>,
    /// Alert when a branch has unpushed commits older than N days
    #[serde(default = "default_unpushed_days")]
    pub unpushed_days: u64,
    /// Alert on branches with no new commits in N days (stale cleanup)
    #[serde(default = "default_stale_branch_days")]
    pub stale_branch_days: u64,
    /// Branch name patterns to ignore (e.g. "dependabot/*")
    #[serde(default)]
    pub ignore_branches: Vec<String>,
}

fn default_unpushed_days() -> u64 { 3 }
fn default_stale_branch_days() -> u64 { 14 }

#[derive(Serialize, Deserialize, Clone)]
pub struct CaptureConfig {
    #[serde(default = "default_capture_enabled")]
    pub enabled: bool,
    #[serde(default = "default_capture_port")]
    pub port: u16,
}

fn default_capture_enabled() -> bool { true }
fn default_capture_port() -> u16 { 9111 }

#[derive(Serialize, Deserialize, Clone)]
pub struct UptimeConfig {
    /// URL to health-check (e.g. "https://myapp.com/api/health")
    pub url: String,
    /// Interval in seconds between checks (default: 60)
    #[serde(default = "default_uptime_interval")]
    pub interval_secs: u64,
    /// Consecutive failures before alerting (default: 3)
    #[serde(default = "default_uptime_threshold")]
    pub threshold: u32,
    /// Expected HTTP status (default: 200)
    #[serde(default = "default_uptime_status")]
    pub expected_status: u16,
    /// Request timeout in seconds (default: 10)
    #[serde(default = "default_uptime_timeout")]
    pub timeout_secs: u64,
}

fn default_uptime_interval() -> u64 { 60 }
fn default_uptime_threshold() -> u32 { 3 }
fn default_uptime_status() -> u16 { 200 }
fn default_uptime_timeout() -> u64 { 10 }

#[derive(Serialize, Deserialize, Clone)]
pub struct CronConfig {
    /// Base URL of the InariWatch web app (e.g. "https://app.inariwatch.com")
    pub url: String,
    /// CRON_SECRET for authenticating requests
    pub secret: String,
    /// Cron tasks to run on schedule
    #[serde(default = "default_cron_tasks")]
    pub tasks: Vec<CronTask>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct CronTask {
    pub name: String,
    /// API path (e.g. "/api/cron/poll")
    pub path: String,
    /// Interval in seconds between runs
    #[serde(default = "default_cron_poll_interval")]
    pub interval_secs: u64,
    #[serde(default = "default_cron_enabled")]
    pub enabled: bool,
}

fn default_cron_enabled() -> bool { true }
fn default_cron_poll_interval() -> u64 { 300 }

pub fn default_cron_tasks() -> Vec<CronTask> {
    vec![
        CronTask {
            name: "poll".into(),
            path: "/api/cron/poll".into(),
            interval_secs: 300,
            enabled: true,
        },
        CronTask {
            name: "uptime".into(),
            path: "/api/cron/uptime".into(),
            interval_secs: 60,
            enabled: true,
        },
        CronTask {
            name: "escalate".into(),
            path: "/api/cron/escalate".into(),
            interval_secs: 300,
            enabled: true,
        },
        CronTask {
            name: "digest".into(),
            path: "/api/cron/digest".into(),
            interval_secs: 86400,
            enabled: true,
        },
    ]
}

// ── Notifications ─────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Notifications {
    pub telegram: Option<TelegramConfig>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TelegramConfig {
    pub bot_token: String,
    pub chat_id: String,
}

// ── I/O ───────────────────────────────────────────────────────────────────────

pub fn config_path() -> PathBuf {
    config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("inariwatch")
        .join("config.toml")
}

pub fn load() -> Result<Config> {
    let path = config_path();
    if !path.exists() {
        return Ok(Config::default());
    }
    let content = std::fs::read_to_string(&path)
        .with_context(|| format!("Cannot read config at {}", path.display()))?;
    toml::from_str(&content).context("Invalid config.toml")
}

pub fn save(config: &Config) -> Result<()> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let content = toml::to_string_pretty(config)?;
    std::fs::write(&path, content)?;
    Ok(())
}

// ── Helpers ───────────────────────────────────────────────────────────────────

pub fn current_project(config: &Config) -> Option<&ProjectConfig> {
    let cwd = std::env::current_dir().ok()?;
    config
        .projects
        .iter()
        .find(|p| {
            p.path
                .as_ref()
                .map(|path| PathBuf::from(path) == cwd)
                .unwrap_or(false)
        })
        .or_else(|| config.projects.first())
}

pub fn slugify(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}
