use serde_json::{json, Value};

use crate::ai;
use crate::config;
use crate::db;

pub async fn execute(args: &Value) -> anyhow::Result<String> {
    let alert_id = args["alert_id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("alert_id is required"))?;

    let conn = db::open()?;
    let alert = db::get_alert_by_id(&conn, alert_id)?
        .ok_or_else(|| anyhow::anyhow!("Alert not found: {}", alert_id))?;

    // Check if we already have a stored postmortem for this alert
    let memories = db::get_relevant_memories(&conn, &alert.project, &alert.title, None, 5)?;
    let existing = memories.iter().find(|m| {
        m.alert_title == alert.title && m.postmortem_text.is_some()
    });

    if let Some(mem) = existing {
        return Ok(serde_json::to_string_pretty(&json!({
            "alert_id": alert_id,
            "alert_title": alert.title,
            "source": "stored",
            "postmortem": mem.postmortem_text,
        }))?);
    }

    // Generate a new postmortem
    let cfg = config::load()?;
    let ai_key = cfg.global.ai_key.as_ref().ok_or_else(|| {
        anyhow::anyhow!("No AI key configured. Run `inariwatch config --ai-key <key>`")
    })?;

    let model = Some(cfg.global.ai_model.as_str());

    // Find the best matching memory for remediation context
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
        &[], // no step details available in MCP context
    )
    .await?;

    // Store the postmortem if we have a matching memory
    if let Some(mem) = best_memory {
        let _ = db::update_memory_postmortem(&conn, &mem.id, &postmortem);
    }

    Ok(serde_json::to_string_pretty(&json!({
        "alert_id": alert_id,
        "alert_title": alert.title,
        "source": "generated",
        "postmortem": postmortem,
    }))?)
}
