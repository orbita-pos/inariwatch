use anyhow::Result;
use chrono::Utc;
use colored::Colorize;
use dialoguer::{Confirm, Select};

use crate::config;
use crate::integrations::vercel::VercelClient;

pub async fn run(service: &str, project_name: Option<String>) -> Result<()> {
    match service {
        "vercel" => rollback_vercel(project_name).await,
        _ => {
            println!("{} Unknown service '{}'. Supported: vercel", "✗".red(), service);
            Ok(())
        }
    }
}

async fn rollback_vercel(project_name: Option<String>) -> Result<()> {
    let cfg = config::load()?;

    let project = if let Some(ref name) = project_name {
        cfg.projects
            .iter()
            .find(|p| p.name == *name || p.slug == *name)
            .ok_or_else(|| anyhow::anyhow!("Project '{}' not found", name))?
            .clone()
    } else {
        config::current_project(&cfg)
            .ok_or_else(|| anyhow::anyhow!("No project found. Use --project to specify one."))?
            .clone()
    };

    let vc_cfg = project
        .integrations
        .vercel
        .ok_or_else(|| anyhow::anyhow!("No Vercel integration. Run `inariwatch add vercel`."))?;

    let client = VercelClient::new(&vc_cfg);

    println!("Fetching recent successful deployments for {}…", project.name.bold());
    let deployments = client
        .get_recent_ready_deployments(&vc_cfg.project_id, 10)
        .await?;

    if deployments.is_empty() {
        println!("{} No successful deployments found.", "✗".red());
        return Ok(());
    }

    let items: Vec<String> = deployments
        .iter()
        .map(|d| {
            let meta = d.meta.as_ref();
            let branch = meta.and_then(|m| m.branch.as_deref()).unwrap_or("?");
            let sha = meta
                .and_then(|m| m.commit_sha.as_deref())
                .map(|s| short(s, 7))
                .unwrap_or_default();
            let commit = meta
                .and_then(|m| m.commit_message.as_deref())
                .and_then(|msg| msg.lines().next())
                .unwrap_or("");
            let age = Utc::now() - d.created_at();
            let age_str = if age.num_hours() < 1 {
                format!("{}m ago", age.num_minutes())
            } else if age.num_hours() < 24 {
                format!("{}h ago", age.num_hours())
            } else {
                format!("{}d ago", age.num_days())
            };
            let sha_part = if sha.is_empty() {
                String::new()
            } else {
                format!(" {}", sha)
            };
            format!(
                "{}{} ({}) — {} — {}",
                short(&d.uid, 8),
                sha_part,
                branch,
                truncate(commit, 45),
                age_str
            )
        })
        .collect();

    let selection = Select::new()
        .with_prompt("Roll back to which deployment?")
        .items(&items)
        .default(0)
        .interact()?;

    let target = &deployments[selection];
    let meta = target.meta.as_ref();
    let branch = meta.and_then(|m| m.branch.as_deref()).unwrap_or("?");
    let sha = meta
        .and_then(|m| m.commit_sha.as_deref())
        .map(|s| short(s, 7))
        .unwrap_or_else(|| "?".to_string());

    println!("\n  Deploy:  {}", short(&target.uid, 12));
    println!("  Branch:  {}", branch);
    println!("  Commit:  {}", sha);
    if let Some(ref url) = target.url {
        println!("  URL:     https://{}", url);
    }

    if !Confirm::new()
        .with_prompt("Confirm rollback to production?")
        .default(false)
        .interact()?
    {
        println!("{} Rollback cancelled.", "–".dimmed());
        return Ok(());
    }

    println!("Rolling back…");
    client
        .rollback_to(&vc_cfg.project_id, &target.uid)
        .await?;

    println!("{} Rollback triggered!", "✓".green());
    if let Some(ref url) = target.url {
        println!("  Live at: https://{}", url);
    }

    Ok(())
}

/// Safe substring via chars (never panics on multi-byte or short strings).
fn short(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max.saturating_sub(1)).collect();
        format!("{}…", truncated)
    }
}
