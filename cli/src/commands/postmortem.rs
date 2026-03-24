use anyhow::Result;
use colored::Colorize;

use crate::ai;
use crate::config;
use crate::db;

pub async fn run(alert_id: &str) -> Result<()> {
    let conn = db::open()?;
    let alert = db::get_alert_by_id(&conn, alert_id)?
        .ok_or_else(|| anyhow::anyhow!("Alert not found: {}", alert_id))?;

    // Check for stored postmortem first
    let memories = db::get_relevant_memories(&conn, &alert.project, &alert.title, None, 5)?;
    let existing = memories
        .iter()
        .find(|m| m.alert_title == alert.title && m.postmortem_text.is_some());

    if let Some(mem) = existing {
        println!("{}", "Post-mortem (stored)".bold().cyan());
        println!("{}", "─".repeat(60).dimmed());
        println!("{}", mem.postmortem_text.as_deref().unwrap_or(""));
        return Ok(());
    }

    // Generate new postmortem
    let cfg = config::load()?;
    let ai_key = cfg.global.ai_key.as_ref().ok_or_else(|| {
        anyhow::anyhow!("No AI key configured. Run `inariwatch config --ai-key <key>`")
    })?;

    println!("{} Generating post-mortem for: {}", "...".dimmed(), alert.title.yellow());

    let model = Some(cfg.global.ai_model.as_str());
    let best_memory = memories.iter().find(|m| m.alert_title == alert.title);

    let (diagnosis, fix_explanation, files_changed, confidence, pr_url) = match best_memory {
        Some(mem) => (
            mem.root_cause.clone(),
            mem.fix_summary.clone(),
            mem.files_fixed.clone(),
            mem.confidence as u32,
            mem.pr_url.clone(),
        ),
        None => (
            "No automated remediation performed".to_string(),
            "Manual resolution".to_string(),
            vec![],
            0u32,
            None,
        ),
    };

    let postmortem = ai::generate_postmortem(
        ai_key,
        model,
        &alert.title,
        &alert.body,
        &alert.source_integrations,
        &diagnosis,
        &fix_explanation,
        &files_changed,
        confidence,
        pr_url.as_deref(),
        false,
        &[],
    )
    .await?;

    // Store it
    if let Some(mem) = best_memory {
        let _ = db::update_memory_postmortem(&conn, &mem.id, &postmortem);
    }

    println!("\n{}", "Post-mortem".bold().cyan());
    println!("{}", "─".repeat(60).dimmed());
    println!("{}", postmortem);

    Ok(())
}
