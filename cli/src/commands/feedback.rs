use anyhow::Result;
use colored::Colorize;

use crate::db;

pub async fn run(_project_name: Option<String>) -> Result<()> {
    let conn = db::open()?;
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

        println!();
    }

    println!("  {} All feedback recorded. Thank you!\n", "\u{2713}".green());
    Ok(())
}
