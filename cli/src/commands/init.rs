use anyhow::Result;
use colored::Colorize;
use dialoguer::Input;

use crate::config::{self, Integrations, Notifications, ProjectConfig};

pub async fn run() -> Result<()> {
    println!("{}", "kairo init".bold());
    println!("Setting up a new project\n");

    let mut cfg = config::load().unwrap_or_default();

    let name: String = Input::new()
        .with_prompt("Project name")
        .interact_text()?;

    let slug = config::slugify(&name);

    if cfg.projects.iter().any(|p| p.slug == slug) {
        println!(
            "{} Project '{}' already exists.",
            "✗".red(),
            name
        );
        println!("  Run {} to add integrations.", "kairo add github".cyan());
        return Ok(());
    }

    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let path: String = Input::new()
        .with_prompt("Working directory")
        .default(cwd)
        .interact_text()?;

    cfg.projects.push(ProjectConfig {
        name: name.clone(),
        slug,
        path: Some(path),
        integrations: Integrations::default(),
        notifications: Notifications::default(),
    });

    config::save(&cfg)?;

    println!("\n{} Project {} created.", "✓".green(), name.bold());
    println!("\nNext steps:");
    println!("  {}  — add GitHub monitoring", "kairo add github".cyan());
    println!(
        "  {}  — connect Telegram notifications",
        "kairo connect telegram".cyan()
    );
    println!("  {}          — start monitoring", "kairo watch".cyan());

    Ok(())
}
