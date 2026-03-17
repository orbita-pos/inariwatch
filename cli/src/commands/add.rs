use anyhow::Result;
use colored::Colorize;
use dialoguer::Input;

use crate::config::{self, GitConfig, GithubConfig, SentryConfig, VercelConfig};
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
        other => {
            println!("{} Unknown integration: {}", "✗".red(), other);
            println!("Available: {}", "github  vercel  sentry  git".cyan());
            Ok(())
        }
    }
}

// ── GitHub ────────────────────────────────────────────────────────────────────

async fn add_github() -> Result<()> {
    println!("{}", "kairo add github".bold());
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
    println!("Run {} to start monitoring.", "kairo watch".cyan());
    Ok(())
}

// ── Vercel ────────────────────────────────────────────────────────────────────

async fn add_vercel() -> Result<()> {
    println!("{}", "kairo add vercel".bold());
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
            println!("Run {} to start monitoring.", "kairo watch".cyan());
        }
        Err(e) => println!("{} {}", "✗".red(), e),
    }
    Ok(())
}

// ── Sentry ────────────────────────────────────────────────────────────────────

async fn add_sentry() -> Result<()> {
    println!("{}", "kairo add sentry".bold());
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
    println!("Run {} to start monitoring.", "kairo watch".cyan());
    Ok(())
}

// ── Git local ─────────────────────────────────────────────────────────────────

async fn add_git() -> Result<()> {
    println!("{}", "kairo add git".bold());
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
    println!("Run {} to start monitoring.", "kairo watch".cyan());
    Ok(())
}
