use anyhow::Result;
use colored::Colorize;

use crate::config;
use crate::db;

pub async fn run(limit: usize, project_name: Option<String>) -> Result<()> {
    let cfg = config::load()?;
    let conn = db::open()?;

    let project_slug = project_name.as_ref().and_then(|name| {
        cfg.projects
            .iter()
            .find(|p| p.name == *name || p.slug == *name)
            .map(|p| p.slug.clone())
    });

    let alerts = db::get_recent_alerts(&conn, project_slug.as_deref(), limit)?;

    if alerts.is_empty() {
        println!(
            "No alerts yet. Run {} to start monitoring.",
            "inariwatch watch".cyan()
        );
        return Ok(());
    }

    for alert in &alerts {
        let (icon, severity_color): (&str, Box<dyn Fn(&str) -> colored::ColoredString>) =
            match alert.severity.as_str() {
                "critical" => ("🔴", Box::new(|s: &str| s.red())),
                "warning" => ("⚠️ ", Box::new(|s: &str| s.yellow())),
                _ => ("ℹ️ ", Box::new(|s: &str| s.cyan())),
            };

        let time = alert.created_at.format("%Y-%m-%d %H:%M UTC").to_string();
        let integrations = alert.source_integrations.join(", ");

        println!(
            "{} {}  [{}]  {}",
            icon,
            severity_color(&alert.title),
            integrations.dimmed(),
            time.dimmed()
        );

        for line in alert.body.lines().take(3) {
            println!("   {}", line.dimmed());
        }
        println!();
    }

    Ok(())
}
