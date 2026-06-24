use anyhow::Result;
use colored::Colorize;

use crate::config;

pub async fn run(
    ai_key: Option<String>,
    model: Option<String>,
    auto_fix: Option<bool>,
    auto_merge: Option<bool>,
    fix_replay: Option<bool>,
    fix_replay_url: Option<String>,
    show: bool,
) -> Result<()> {
    let mut cfg = config::load()?;

    let no_args = ai_key.is_none() && model.is_none() && auto_fix.is_none()
        && auto_merge.is_none() && fix_replay.is_none() && fix_replay_url.is_none();
    if show || no_args {
        println!("{}", "inariwatch config".bold());
        println!();

        let key_display = cfg.global.ai_key.as_ref().map_or_else(
            || "not set".dimmed().to_string(),
            |k| {
                let visible = &k[..8.min(k.len())];
                format!("{}...", visible).yellow().to_string()
            },
        );

        println!("  AI key:      {}", key_display);
        println!("  AI model:    {}", cfg.global.ai_model.cyan());
        println!(
            "  auto_fix:    {}",
            if cfg.global.auto_fix { "on".green().to_string() } else { "off".dimmed().to_string() }
        );
        println!(
            "  auto_merge:  {}",
            if cfg.global.auto_merge { "on".green().to_string() } else { "off".dimmed().to_string() }
        );
        println!(
            "  fix_replay:  {}",
            if cfg.global.fix_replay { "on".green().to_string() } else { "off".dimmed().to_string() }
        );
        if let Some(url) = &cfg.global.fix_replay_url {
            println!("  replay_url:  {}", url.cyan());
        }
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
    if let Some(v) = auto_fix {
        cfg.global.auto_fix = v;
        println!("{} auto_fix = {}", "✓".green(), if v { "on".green().to_string() } else { "off".dimmed().to_string() });
    }
    if let Some(v) = auto_merge {
        cfg.global.auto_merge = v;
        println!("{} auto_merge = {}", "✓".green(), if v { "on".green().to_string() } else { "off".dimmed().to_string() });
    }
    if let Some(v) = fix_replay {
        cfg.global.fix_replay = v;
        println!("{} fix_replay = {}", "✓".green(), if v { "on".green().to_string() } else { "off".dimmed().to_string() });
    }
    if let Some(url) = fix_replay_url {
        cfg.global.fix_replay_url = Some(url.clone());
        println!("{} fix_replay_url = {}", "✓".green(), url.cyan());
    }

    config::save(&cfg)?;
    Ok(())
}
