use anyhow::Result;
use colored::Colorize;

use crate::config;

pub async fn run(
    ai_key: Option<String>,
    model: Option<String>,
    show: bool,
) -> Result<()> {
    let mut cfg = config::load()?;

    if show || (ai_key.is_none() && model.is_none()) {
        println!("{}", "kairo config".bold());
        println!();

        let key_display = cfg.global.ai_key.as_ref().map_or_else(
            || "not set".dimmed().to_string(),
            |k| {
                let visible = &k[..8.min(k.len())];
                format!("{}...", visible).yellow().to_string()
            },
        );

        println!("  AI key:   {}", key_display);
        println!("  AI model: {}", cfg.global.ai_model.cyan());
        println!();
        println!(
            "  Config file: {}",
            config::config_path().display().to_string().dimmed()
        );
        return Ok(());
    }

    if let Some(key) = ai_key {
        cfg.global.ai_key = Some(key);
        println!("{} AI key saved.", "✓".green());
    }

    if let Some(m) = model {
        println!("{} AI model set to {}.", "✓".green(), m.cyan());
        cfg.global.ai_model = m;
    }

    config::save(&cfg)?;
    Ok(())
}
