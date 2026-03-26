use std::collections::HashMap;
use std::time::Instant;

use anyhow::Result;
use chrono::Utc;
use colored::Colorize;
use dialoguer::Confirm;
use uuid::Uuid;

use crate::ai;
use crate::ai::prompts::{MemoryHint, RemediationContext};
use crate::config;
use crate::db;
use crate::local_fs;
use crate::mcp::fingerprint;
use crate::mcp::safety;
use crate::orchestrator::RawEvent;

/// Dedup window: skip errors with the same fingerprint fixed within this duration.
const DEDUP_SECS: u64 = 60;

pub async fn run(project_name: Option<String>, port: Option<u16>) -> Result<()> {
    println!(
        "\n  {} {}\n",
        "◉".cyan(),
        "INARIWATCH DEV".bold()
    );

    let cfg = config::load()?;

    if cfg.projects.is_empty() {
        println!(
            "{} No projects. Run {} first.",
            "✗".red(),
            "inariwatch init".cyan()
        );
        return Ok(());
    }

    let project = if let Some(ref name) = project_name {
        cfg.projects
            .iter()
            .find(|p| p.name == *name || p.slug == *name)
            .ok_or_else(|| anyhow::anyhow!("Project '{}' not found", name))?
            .clone()
    } else {
        config::current_project(&cfg)
            .ok_or_else(|| anyhow::anyhow!("No project. Run inariwatch init."))?
            .clone()
    };

    // Validate AI key
    let ai_key = match &cfg.global.ai_key {
        Some(k) if !k.is_empty() => k.as_str(),
        _ => anyhow::bail!("No AI key configured. Run: inariwatch config --ai-key <your-key>"),
    };

    let model = Some(cfg.global.ai_model.as_str());

    // Resolve project root
    let project_root = project
        .path
        .clone()
        .unwrap_or_else(|| {
            std::env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| ".".to_string())
        });

    // Start capture server
    let capture_port = port
        .or_else(|| project.integrations.capture.as_ref().map(|c| c.port))
        .unwrap_or(9111);

    let (_handle, mut capture_rx) = crate::capture_server::start_capture_server(capture_port);

    println!(
        "  {} Dev mode — {} | Capture :{} | {}",
        "◉".cyan(),
        project.name.bold(),
        capture_port.to_string().yellow(),
        "Ctrl+C to stop".dimmed()
    );
    println!(
        "  {} Errors from your dev server will be diagnosed and fixed locally.\n",
        "→".dimmed()
    );

    // Dedup tracker: fingerprint → last fixed time
    let mut recent_fixes: HashMap<String, Instant> = HashMap::new();

    // Open local DB
    let conn = db::open()?;

    // Event loop — block on capture events, no polling
    loop {
        let event = match capture_rx.recv().await {
            Some(e) => e,
            None => break, // channel closed
        };

        if let Err(e) = handle_capture_event(
            &event,
            ai_key,
            model,
            &project,
            &project_root,
            &conn,
            &mut recent_fixes,
        )
        .await
        {
            eprintln!("  {} {}", "Error:".red(), e);
        }
    }

    Ok(())
}

async fn handle_capture_event(
    event: &RawEvent,
    ai_key: &str,
    model: Option<&str>,
    project: &config::ProjectConfig,
    project_root: &str,
    conn: &rusqlite::Connection,
    recent_fixes: &mut HashMap<String, Instant>,
) -> Result<()> {
    // Skip non-error events (deploys, info logs)
    if event.event_type == "deploy" || event.severity == "info" {
        return Ok(());
    }

    let title = &event.title;
    let body = &event.detail;

    println!(
        "\n  {} {}",
        "🔴".red(),
        title.bold()
    );
    if !body.is_empty() {
        // Show first 3 lines of the error
        for line in body.lines().take(3) {
            println!("     {}", line.dimmed());
        }
    }

    // Compute fingerprint
    let fp = fingerprint::compute_error_fingerprint(title, body);

    // Dedup: skip if we recently fixed this exact error
    if let Some(last) = recent_fixes.get(&fp) {
        if last.elapsed().as_secs() < DEDUP_SECS {
            println!("     {} Same error — skipping (fixed {}s ago)", "↳".dimmed(), last.elapsed().as_secs());
            return Ok(());
        }
    }

    // Memory lookup
    let raw_memories = db::get_relevant_memories(conn, &project.slug, title, Some(&fp), 3)
        .unwrap_or_default();

    if !raw_memories.is_empty() {
        let best = &raw_memories[0];
        println!(
            "     {} Known pattern (confidence: {}%) — {}",
            "💡".yellow(),
            best.confidence,
            best.fix_summary.chars().take(80).collect::<String>()
        );
    }

    let past_hints: Vec<MemoryHint> = raw_memories
        .iter()
        .map(|m| MemoryHint {
            alert_title: m.alert_title.clone(),
            root_cause: m.root_cause.clone(),
            fix_summary: m.fix_summary.clone(),
            files_fixed: m.files_fixed.clone(),
            confidence: m.confidence,
        })
        .collect();

    // Walk local filesystem
    print!("     {} Scanning project files... ", "→".dimmed());
    let repo_files = local_fs::walk_project_files(project_root)?;
    println!("{} files", repo_files.len());

    // AI diagnose
    print!("     {} Diagnosing... ", "→".dimmed());
    let sources = vec!["capture".to_string()];
    let error_details = format!("{}\n{}", title, body);
    let context = RemediationContext::default();

    let diagnosis_result = ai::diagnose(
        ai_key,
        model,
        title,
        body,
        &sources,
        &repo_files,
        &context,
        None,
        &past_hints,
    )
    .await?;

    let diagnosis = diagnosis_result["diagnosis"]
        .as_str()
        .unwrap_or("Unknown")
        .to_string();
    let confidence = diagnosis_result["confidence"].as_u64().unwrap_or(0) as u32;
    let files_to_read: Vec<String> = diagnosis_result["filesToRead"]
        .as_array()
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    println!("{}% confidence", confidence);
    println!("     {} {}", "Diagnosis:".cyan(), diagnosis);

    if confidence < 20 {
        println!("     {} Confidence too low — skipping.", "⚠".yellow());
        return Ok(());
    }

    // Read local files
    let mut file_contents: Vec<(String, String)> = Vec::new();
    for path in files_to_read.iter().take(5) {
        if !safety::is_safe_file_path(path) {
            continue;
        }
        if let Some(content) = local_fs::read_project_file(project_root, path) {
            file_contents.push((path.clone(), content));
        }
    }

    if file_contents.is_empty() {
        println!("     {} Could not read any source files.", "✗".red());
        return Ok(());
    }

    println!(
        "     {} Read {} file(s): {}",
        "→".dimmed(),
        file_contents.len(),
        file_contents.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>().join(", ")
    );

    // Generate fix
    print!("     {} Generating fix... ", "→".dimmed());
    let file_refs: Vec<(&str, &str)> = file_contents
        .iter()
        .map(|(p, c)| (p.as_str(), c.as_str()))
        .collect();

    let fix_result = ai::generate_fix(ai_key, model, &diagnosis, &file_refs, &error_details, None).await?;

    let fix_explanation = fix_result["explanation"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let fix_files: Vec<(String, String)> = fix_result["files"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|f| {
                    let path = f["path"].as_str()?;
                    let content = f["content"].as_str()?;
                    if safety::is_safe_file_path(path) {
                        Some((path.to_string(), content.to_string()))
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    if fix_files.is_empty() {
        println!("no safe changes generated.");
        return Ok(());
    }
    println!("done");

    // Self-review
    print!("     {} Self-reviewing... ", "→".dimmed());
    let original_refs: Vec<(&str, &str)> = file_contents
        .iter()
        .map(|(p, c)| (p.as_str(), c.as_str()))
        .collect();
    let fixed_refs: Vec<(&str, &str)> = fix_files
        .iter()
        .map(|(p, c)| (p.as_str(), c.as_str()))
        .collect();

    let review = ai::self_review(ai_key, model, &diagnosis, &original_refs, &fixed_refs, &error_details).await?;
    let review_score = review["score"].as_u64().unwrap_or(0) as u32;
    let recommendation = review["recommendation"].as_str().unwrap_or("flag");

    println!("{}/100 ({})", review_score, recommendation);

    if recommendation == "reject" {
        println!("     {} Self-review rejected this fix. Skipping.", "✗".red());
        return Ok(());
    }

    // Display diff
    println!("\n     {}", "─".repeat(50).dimmed());
    println!("     {} {}\n", "Fix:".green().bold(), fix_explanation);

    for (path, new_content) in &fix_files {
        println!("     {}", format!("--- {} (original)", path).red());
        println!("     {}", format!("+++ {} (fixed)", path).green());
        println!("     {}", "─".repeat(50).dimmed());

        let original = file_contents
            .iter()
            .find(|(p, _)| p == path)
            .map(|(_, c)| c.as_str())
            .unwrap_or("");

        let old_lines: Vec<&str> = original.lines().collect();
        let new_lines: Vec<&str> = new_content.lines().collect();

        // Simple diff: show changed regions
        let max = old_lines.len().max(new_lines.len());
        for i in 0..max {
            let old = old_lines.get(i).copied().unwrap_or("");
            let new = new_lines.get(i).copied().unwrap_or("");
            if old == new {
                // Context — only show lines near changes
            } else {
                if !old.is_empty() {
                    println!("     {}", format!("-{}", old).red());
                }
                if !new.is_empty() {
                    println!("     {}", format!("+{}", new).green());
                }
            }
        }
        println!();
    }

    println!("     {} Confidence: {}% | Review: {}/100", "→".dimmed(), confidence, review_score);
    println!();

    // Confirm
    let apply = Confirm::new()
        .with_prompt("     Apply fix?")
        .default(false)
        .interact()
        .unwrap_or(false);

    if !apply {
        println!("     {} Skipped.\n", "→".dimmed());
        return Ok(());
    }

    // Apply fix to disk
    let mut applied = 0;
    for (path, content) in &fix_files {
        let full_path = std::path::Path::new(project_root).join(path);
        match std::fs::write(&full_path, content) {
            Ok(_) => {
                println!("     {} Saved {}", "✓".green(), path);
                applied += 1;
            }
            Err(e) => {
                eprintln!("     {} Failed to write {}: {}", "✗".red(), path, e);
            }
        }
    }

    if applied == 0 {
        return Ok(());
    }

    // Save to incident memory
    let mem = db::IncidentMemory {
        id: Uuid::new_v4().to_string(),
        project: project.slug.clone(),
        alert_title: title.clone(),
        root_cause: diagnosis.clone(),
        fix_summary: fix_explanation.clone(),
        files_fixed: fix_files.iter().map(|(p, _)| p.clone()).collect(),
        fix_worked: true,
        confidence: confidence as i64,
        pr_url: None,
        created_at: Utc::now(),
        fingerprint: Some(fp.clone()),
        postmortem_text: None,
        community_fix_id: None,
    };
    let _ = db::save_incident_memory(conn, &mem);

    // Track for dedup
    recent_fixes.insert(fp.clone(), Instant::now());

    // Contribute to network if enabled
    let cfg_reload = config::load().unwrap_or_default();
    if cfg_reload.global.fix_replay {
        if let Some(ref base_url) = cfg_reload.global.fix_replay_url {
            let changed_paths: Vec<String> = fix_files.iter().map(|(p, _)| p.clone()).collect();
            let _ = crate::mcp::tools::trigger_fix::contribute_fix_replay(
                &fp,
                title,
                "runtime_error",
                &fix_explanation,
                &diagnosis,
                &changed_paths,
                confidence,
                base_url,
            )
            .await;
            println!("     {} Contributed to network.", "↑".cyan());
        }
    }

    println!(
        "     {} Fix applied. Memory saved.\n",
        "✓".green().bold()
    );

    Ok(())
}
