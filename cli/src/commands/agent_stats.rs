use anyhow::Result;
use colored::Colorize;

use crate::config;
use crate::db::{self, TrustLevel};

pub async fn run(project_name: Option<String>) -> Result<()> {
    let cfg = config::load()?;

    let project = if let Some(ref name) = project_name {
        cfg.projects
            .iter()
            .find(|p| p.name == *name || p.slug == *name)
            .ok_or_else(|| anyhow::anyhow!("Project '{}' not found", name))?
            .clone()
    } else {
        config::current_project(&cfg)
            .ok_or_else(|| anyhow::anyhow!("No project found. Run `inariwatch init` first."))?
            .clone()
    };

    let conn = db::open()?;
    let rec = db::get_track_record(&conn, &project.slug)?;

    // ── Header ────────────────────────────────────────────────────────────────

    println!();
    println!("  {}  ·  AI Agent Track Record", "Inari".bold());
    println!("  {}", "─".repeat(44).dimmed());
    println!();

    // Trust level badge
    let (level_color, level_icon) = match rec.trust_level {
        TrustLevel::Rookie     => ("⬤".red(),     "Rookie     (Level 0 / 3)"),
        TrustLevel::Apprentice => ("⬤".yellow(),  "Apprentice (Level 1 / 3)"),
        TrustLevel::Trusted    => ("⬤".cyan(),    "Trusted    (Level 2 / 3)"),
        TrustLevel::Expert     => ("⬤".green(),   "Expert     (Level 3 / 3)"),
    };
    println!("  Trust level:  {} {}", level_color, level_icon.bold());

    // Progress to next level
    if let Some(next) = rec.fixes_to_next_level() {
        println!("  Next level:   {}", next.dimmed());
    } else {
        println!("  {}  Maximum trust level reached.", "★".yellow());
    }

    println!();

    // ── Auto-merge gates for current level ───────────────────────────────────

    let gates = match rec.trust_level {
        TrustLevel::Rookie => "  Auto-merge:   disabled (not enough track record yet)".to_string(),
        _ => format!(
            "  Auto-merge:   confidence ≥ {}%  ·  review score ≥ {}  ·  lines ≤ {}",
            rec.trust_level.min_confidence(),
            rec.trust_level.min_review_score(),
            rec.trust_level.max_changed_lines(),
        ),
    };
    println!("{}", gates.dimmed());
    println!();

    // ── Stats table ───────────────────────────────────────────────────────────

    let rate_str = if rec.total > 0 {
        format!("  ({:.0}%)", rec.success_rate * 100.0)
    } else {
        String::new()
    };

    println!(
        "  {:<20} {}",
        "Total fixes".dimmed(),
        rec.total.to_string().bold()
    );
    println!(
        "  {:<20} {}{}",
        "Successful".dimmed(),
        rec.succeeded.to_string().green().bold(),
        rate_str.dimmed()
    );
    println!(
        "  {:<20} {}",
        "Failed".dimmed(),
        if rec.failed > 0 {
            rec.failed.to_string().red().bold()
        } else {
            "0".normal()
        }
    );
    println!(
        "  {:<20} {:.0}%",
        "Avg confidence".dimmed(),
        rec.avg_confidence
    );
    println!(
        "  {:<20} {}",
        "Auto-merged".dimmed(),
        rec.auto_merged.to_string().bold()
    );

    // ── Fix Replay ───────────────────────────────────────────────────────────

    if let Ok(replay) = db::get_fix_replay_stats(&conn, &project.slug) {
        println!();
        println!("  {}", "Fix Replay:".dimmed());
        println!(
            "  {:<20} {}",
            "Cache entries".dimmed(),
            replay.cache_entries.to_string().bold()
        );
        println!(
            "  {:<20} {}",
            "FP matches".dimmed(),
            replay.fingerprint_matches.to_string().cyan().bold()
        );
        println!(
            "  {:<20} {}",
            "Contributions".dimmed(),
            replay.contributions.to_string().green().bold()
        );
    }

    // ── Recent fixes ─────────────────────────────────────────────────────────

    if rec.recent.is_empty() {
        println!();
        println!(
            "  {}  No fixes yet. Run {} to resolve an alert.",
            "ℹ".cyan(),
            "inariwatch watch".cyan()
        );
    } else {
        println!();
        println!("  {}", "Recent fixes:".dimmed());
        for mem in &rec.recent {
            let icon = if mem.fix_worked { "✓".green() } else { "✗".red() };
            let title: String = mem.alert_title.chars().take(52).collect();
            let pr = mem
                .pr_url
                .as_deref()
                .map(|u| format!("→ {}", u))
                .unwrap_or_else(|| "→ no PR".to_string());
            println!(
                "  {}  {:>3}%  {:<52}  {}",
                icon,
                mem.confidence,
                title,
                pr.dimmed()
            );
        }
    }

    println!();
    Ok(())
}
