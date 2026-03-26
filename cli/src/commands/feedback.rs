use anyhow::Result;
use colored::Colorize;

use crate::config;
use crate::db;

pub async fn run(_project_name: Option<String>) -> Result<()> {
    let conn = db::open()?;
    let cfg = config::load()?;
    let pending = db::get_pending_feedback(&conn, 20)?;

    if pending.is_empty() {
        println!("  {} No pending feedback requests.", "\u{2713}".green());
        return Ok(());
    }

    println!(
        "\n  {} pending fix review(s):\n",
        pending.len().to_string().yellow().bold()
    );

    for fb in &pending {
        println!("  Fix: \"{}\"", fb.alert_title.bold());
        if let Some(url) = &fb.pr_url {
            println!("    PR: {}", url.cyan());
        }
        let summary: String = fb.fix_summary.chars().take(120).collect();
        println!("    Fix: {}", summary.dimmed());

        let worked = dialoguer::Confirm::new()
            .with_prompt("    Did this fix work?")
            .default(true)
            .interact()?;

        db::answer_feedback(&conn, &fb.id, worked)?;

        if !worked {
            let _ = db::mark_memory_failed(&conn, &fb.memory_id);
            println!("    {} Marked as failed.", "\u{2717}".red());
        } else {
            println!("    {} Marked as successful.", "\u{2713}".green());
        }

        // Sync to cloud if Fix Replay is enabled
        if cfg.global.fix_replay {
            if let Some(ref base_url) = cfg.global.fix_replay_url {
                if let Some(ref fix_id) = fb.community_fix_id {
                    let url = format!("{}/api/patterns/rate", base_url.trim_end_matches('/'));
                    let payload = serde_json::json!({
                        "fixId": fix_id,
                        "worked": worked,
                        "rating": if worked { 5 } else { 1 },
                    });

                    match reqwest::Client::new()
                        .post(&url)
                        .json(&payload)
                        .timeout(std::time::Duration::from_secs(10))
                        .send()
                        .await
                    {
                        Ok(resp) if resp.status().is_success() => {
                            println!("    {} Synced to cloud.", "↑".cyan());
                        }
                        Ok(resp) => {
                            println!("    {} Cloud sync: HTTP {}", "⚠".yellow(), resp.status());
                        }
                        Err(_) => {
                            println!("    {} Cloud sync unavailable (saved locally).", "⚠".yellow());
                        }
                    }
                }
            }
        }

        println!();
    }

    println!("  {} All feedback recorded. Thank you!\n", "\u{2713}".green());
    Ok(())
}
