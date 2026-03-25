use anyhow::Result;
use colored::Colorize;
use dialoguer::Input;

use crate::config::{self, CaptureConfig, GitConfig, GithubConfig, SentryConfig, UptimeConfig, VercelConfig};
use crate::integrations::git_local;
use crate::integrations::github::GitHubClient;
use crate::integrations::sentry::SentryClient;
use crate::integrations::vercel::VercelClient;

pub async fn run(integration: &str) -> Result<()> {
    match integration.to_lowercase().as_str() {
        "github" => add_github().await,
        "vercel" => add_vercel().await,
        "sentry" => add_sentry().await,
        "git" => add_git().await,
        "capture" => add_capture().await,
        "uptime" => add_uptime().await,
        other => {
            println!("{} Unknown integration: {}", "✗".red(), other);
            println!("Available: {}", "github  vercel  sentry  git  capture  uptime".cyan());
            Ok(())
        }
    }
}

// ── GitHub ────────────────────────────────────────────────────────────────────

async fn add_github() -> Result<()> {
    println!("{}", "inariwatch add github".bold());
    println!("Connect your GitHub repository\n");

    let mut cfg = config::load()?;
    let idx = super::pick_project(&cfg)?;

    println!(
        "Create a token at: {}",
        "https://github.com/settings/tokens/new".cyan()
    );
    println!("Required scopes:   {}", "repo  workflow".yellow());
    println!();

    let token: String = Input::new()
        .with_prompt("GitHub token (ghp_...)")
        .interact_text()?;

    let repo: String = Input::new()
        .with_prompt("Repository (owner/repo)")
        .interact_text()?;

    let stale_days: u64 = Input::new()
        .with_prompt("Alert when PR has no activity for (days)")
        .default(2u64)
        .interact_text()?;

    let gh_cfg = GithubConfig { token, repo, stale_pr_days: stale_days };

    print!("Testing connection... ");
    match GitHubClient::new(&gh_cfg).test_connection().await {
        Ok(name) => println!("{} {}", "✓".green(), name.bold()),
        Err(e) => {
            println!("{} {}", "✗".red(), e);
            return Ok(());
        }
    }

    cfg.projects[idx].integrations.github = Some(gh_cfg);
    config::save(&cfg)?;
    println!("\n{} GitHub added to {}.", "✓".green(), cfg.projects[idx].name.bold());
    println!("Run {} to start monitoring.", "inariwatch watch".cyan());
    Ok(())
}

// ── Vercel ────────────────────────────────────────────────────────────────────

async fn add_vercel() -> Result<()> {
    println!("{}", "inariwatch add vercel".bold());
    println!("Connect your Vercel project\n");

    let mut cfg = config::load()?;
    let idx = super::pick_project(&cfg)?;

    println!("Create a token at: {}", "https://vercel.com/account/tokens".cyan());
    println!();

    let token: String = Input::new().with_prompt("Vercel token").interact_text()?;

    let project_name: String = Input::new()
        .with_prompt("Project name (as shown in Vercel dashboard)")
        .interact_text()?;

    let team_id_raw: String = Input::new()
        .with_prompt("Team ID (leave empty for personal account)")
        .allow_empty(true)
        .interact_text()?;

    let team_id = (!team_id_raw.trim().is_empty()).then(|| team_id_raw.trim().to_string());

    print!("Testing connection... ");
    let client = VercelClient::with_token(&token, team_id.clone());
    match client.get_project(&project_name).await {
        Ok(project) => {
            println!("{} {} ({})", "✓".green(), project.name.bold(), project.id.dimmed());
            cfg.projects[idx].integrations.vercel = Some(VercelConfig {
                token,
                project_id: project.id,
                team_id,
            });
            config::save(&cfg)?;
            println!("\n{} Vercel added to {}.", "✓".green(), cfg.projects[idx].name.bold());
            println!("Run {} to start monitoring.", "inariwatch watch".cyan());
        }
        Err(e) => println!("{} {}", "✗".red(), e),
    }
    Ok(())
}

// ── Sentry ────────────────────────────────────────────────────────────────────

async fn add_sentry() -> Result<()> {
    println!("{}", "inariwatch add sentry".bold());
    println!("Connect your Sentry project\n");

    let mut cfg = config::load()?;
    let idx = super::pick_project(&cfg)?;

    println!("Create a token at: {}", "https://sentry.io/settings/account/api/auth-tokens/".cyan());
    println!("Required scopes:   {}", "project:read  event:read".yellow());
    println!();

    let token: String = Input::new().with_prompt("Sentry auth token").interact_text()?;

    let org: String = Input::new()
        .with_prompt("Organization slug (from your Sentry URL)")
        .interact_text()?;

    let project: String = Input::new()
        .with_prompt("Project slug")
        .interact_text()?;

    let sentry_cfg = SentryConfig { token, org, project };

    print!("Testing connection... ");
    match SentryClient::new(&sentry_cfg).test_connection().await {
        Ok(name) => println!("{} {}", "✓".green(), name.bold()),
        Err(e) => {
            println!("{} {}", "✗".red(), e);
            return Ok(());
        }
    }

    cfg.projects[idx].integrations.sentry = Some(sentry_cfg);
    config::save(&cfg)?;
    println!("\n{} Sentry added to {}.", "✓".green(), cfg.projects[idx].name.bold());
    println!("Run {} to start monitoring.", "inariwatch watch".cyan());
    Ok(())
}

// ── Git local ─────────────────────────────────────────────────────────────────

async fn add_git() -> Result<()> {
    println!("{}", "inariwatch add git".bold());
    println!("Monitor your local git repository\n");

    let mut cfg = config::load()?;
    let idx = super::pick_project(&cfg)?;

    // Default repo path: project path or cwd
    let default_path = cfg.projects[idx]
        .path
        .clone()
        .unwrap_or_else(|| {
            std::env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default()
        });

    let repo_path: String = Input::new()
        .with_prompt("Path to git repository")
        .default(default_path)
        .interact_text()?;

    let unpushed_days: u64 = Input::new()
        .with_prompt("Alert when branch has unpushed commits older than (days)")
        .default(3u64)
        .interact_text()?;

    let stale_days: u64 = Input::new()
        .with_prompt("Alert on branches with no commits in (days)")
        .default(14u64)
        .interact_text()?;

    // Verify it's a git repo
    print!("Verifying git repository... ");
    match git_local::verify_repo(&repo_path) {
        Ok(root) => {
            let branches = git_local::list_branches(&root).unwrap_or_default();
            let current = git_local::current_branch(&root).unwrap_or_else(|_| "unknown".into());
            println!(
                "{} {} branch(es), current: {}",
                "✓".green(),
                branches.len(),
                current.cyan()
            );
        }
        Err(e) => {
            println!("{} {}", "✗".red(), e);
            return Ok(());
        }
    }

    let git_cfg = GitConfig {
        path: Some(repo_path),
        unpushed_days,
        stale_branch_days: stale_days,
        ignore_branches: vec!["dependabot/*".into(), "renovate/*".into()],
    };

    cfg.projects[idx].integrations.git = Some(git_cfg);
    config::save(&cfg)?;
    println!("\n{} Git monitoring added to {}.", "✓".green(), cfg.projects[idx].name.bold());
    println!("Run {} to start monitoring.", "inariwatch watch".cyan());
    Ok(())
}

// ── Capture ──────────────────────────────────────────────────────────────────

async fn add_capture() -> Result<()> {
    println!("{}", "inariwatch add capture".bold());
    println!("Enable direct error capture (replaces Sentry)\n");

    let mut cfg = config::load()?;
    let idx = super::pick_project(&cfg)?;

    let port: u16 = Input::new()
        .with_prompt("Capture server port")
        .default(9111u16)
        .interact_text()?;

    cfg.projects[idx].integrations.capture = Some(CaptureConfig { enabled: true, port });
    config::save(&cfg)?;

    println!("\n{} Capture enabled for {}.\n", "✓".green(), cfg.projects[idx].name.bold());
    println!("  {} Setup your project:\n", "→".cyan());
    println!("  1. Install:  {}", "npm install @inariwatch/capture".cyan());
    println!("  2. Create {} in your project root:\n", "instrumentation.ts".bold());
    println!("     {}",  "import { captureRequestError } from \"@inariwatch/capture\"".dimmed());
    println!("     {}", "export { captureRequestError as onRequestError }".dimmed());
    println!("     {}", "export async function register() {".dimmed());
    println!("     {}",  "  const { init } = await import(\"@inariwatch/capture\")".dimmed());
    println!("     {}",  format!("  init({{ dsn: \"http://localhost:{}/ingest\" }})", port).dimmed());
    println!("     {}\n", "}".dimmed());
    println!("  3. Run:  {}\n", "inariwatch watch".cyan());
    println!("  Capture server will listen on port {} during watch.", port.to_string().yellow());
    Ok(())
}

// ── Uptime ───────────────────────────────────────────────────────────────────

async fn add_uptime() -> Result<()> {
    println!("{}", "inariwatch add uptime".bold());
    println!("Monitor your app's health endpoint\n");

    let mut cfg = config::load()?;
    let idx = super::pick_project(&cfg)?;

    let url: String = Input::new()
        .with_prompt("Health check URL (e.g. https://myapp.com/api/health)")
        .interact_text()?;

    let interval: u64 = Input::new()
        .with_prompt("Check interval (seconds)")
        .default(60u64)
        .interact_text()?;

    let threshold: u32 = Input::new()
        .with_prompt("Alert after consecutive failures")
        .default(3u32)
        .interact_text()?;

    // Quick test
    print!("Testing endpoint... ");
    match reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
    {
        Ok(resp) => println!("{} HTTP {}", "✓".green(), resp.status().as_u16().to_string().bold()),
        Err(e) => println!("{} {} (will still save)", "⚠".yellow(), e),
    }

    cfg.projects[idx].integrations.uptime = Some(UptimeConfig {
        url,
        interval_secs: interval,
        threshold,
        expected_status: 200,
        timeout_secs: 10,
    });
    config::save(&cfg)?;

    println!("\n{} Uptime monitoring added to {}.", "✓".green(), cfg.projects[idx].name.bold());
    println!("Run {} to start monitoring.", "inariwatch watch".cyan());
    Ok(())
}
