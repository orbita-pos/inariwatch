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
}

impl Default for GlobalConfig {
    fn default() -> Self {
        Self {
            ai_key: None,
            ai_model: default_model(),
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
