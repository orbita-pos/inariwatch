use anyhow::Result;
use colored::Colorize;

use crate::config;

pub async fn run(project_name: Option<String>) -> Result<()> {
    let cfg = config::load()?;

    if cfg.projects.is_empty() {
        println!(
            "No projects. Run {} to get started.",
            "kairo init".cyan()
        );
        return Ok(());
    }

    let projects: Vec<_> = match &project_name {
        Some(name) => cfg
            .projects
            .iter()
            .filter(|p| p.name == *name || p.slug == *name)
            .collect(),
        None => cfg.projects.iter().collect(),
    };

    for p in &projects {
        println!("{} {}", "◉".cyan(), p.name.bold());

        if let Some(path) = &p.path {
            println!("  path: {}", path.dimmed());
        }
        println!();

        println!("  Integrations");
        print_integration(
            "GitHub",
            p.integrations.github.as_ref().map(|g| {
                format!(
                    "{} (stale PR threshold: {}d)",
                    g.repo.cyan(),
                    g.stale_pr_days
                )
            }),
        );
        print_integration(
            "Vercel",
            p.integrations
                .vercel
                .as_ref()
                .map(|v| v.project_id.cyan().to_string()),
        );
        print_integration(
            "Sentry",
            p.integrations
                .sentry
                .as_ref()
                .map(|s| format!("{}/{}", s.org, s.project).cyan().to_string()),
        );
        print_integration(
            "Git",
            p.integrations.git.as_ref().map(|g| {
                format!(
                    "{} (unpushed: {}d, stale: {}d)",
                    g.path.as_deref().unwrap_or(".").cyan(),
                    g.unpushed_days,
                    g.stale_branch_days,
                )
            }),
        );

        println!();
        println!("  Notifications");
        print_integration(
            "Telegram",
            p.notifications.telegram.as_ref().map(|t| {
                format!(
                    "chat {} (token: {}...)",
                    t.chat_id.cyan(),
                    &t.bot_token[..10.min(t.bot_token.len())]
                )
            }),
        );

        println!();
    }

    // Global AI config
    match &cfg.global.ai_key {
        Some(_) => println!(
            "AI  {} ({})",
            "configured".green(),
            cfg.global.ai_model.cyan()
        ),
        None => println!(
            "AI  {} — run {} to enable smart correlation",
            "not configured".dimmed(),
            "kairo config --ai-key <key>".cyan()
        ),
    }

    println!();
    println!("Config: {}", config::config_path().display().to_string().dimmed());

    Ok(())
}

fn print_integration(name: &str, detail: Option<String>) {
    match detail {
        Some(d) => println!("    {} {:<10} {}", "✓".green(), name, d),
        None => println!("    {} {}", "○".dimmed(), name.dimmed()),
    }
}
