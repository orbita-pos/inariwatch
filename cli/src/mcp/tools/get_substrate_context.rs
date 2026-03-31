use serde_json::{json, Value};

use crate::config;
use crate::db;

/// Get I/O recording context for an alert from the InariWatch network.
/// Falls back to local incident memory if the web API is unavailable.
pub async fn execute(args: &Value) -> anyhow::Result<String> {
    let alert_id = args["alert_id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("alert_id is required"))?;

    let conn = db::open()?;
    let alert = db::get_alert_by_id(&conn, alert_id)?
        .ok_or_else(|| anyhow::anyhow!("Alert not found: {}", alert_id))?;

    let cfg = config::load()?;
    let base_url = cfg.global.fix_replay_url.as_deref();

    // Try the web API first if configured
    if let Some(base) = base_url {
        if let Some(fingerprint) = &alert.fingerprint {
            let url = format!(
                "{}/api/recordings/context?fingerprint={}",
                base.trim_end_matches('/'),
                urlencoding::encode(fingerprint)
            );

            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()?;

            if let Ok(resp) = client.get(&url).send().await {
                if resp.status().is_success() {
                    if let Ok(body) = resp.json::<Value>().await {
                        return format_substrate_response(&alert.title, &body);
                    }
                }
            }
        }
    }

    // Fallback: local incident memory for this alert's fingerprint
    if let Some(fingerprint) = &alert.fingerprint {
        let memories = db::get_memories_by_fingerprint(&conn, &alert.project, fingerprint, 3)?;
        if !memories.is_empty() {
            let mut out = format!(
                "Substrate context for alert: {}\n{}\n\n",
                alert.title,
                "=".repeat(50)
            );
            out.push_str("Source: local incident memory (no substrate recording available)\n\n");

            for mem in &memories {
                out.push_str(&format!(
                    "Past fix (confidence: {}%):\n  Root cause: {}\n  Fix: {}\n  Files: {}\n  Worked: {}\n\n",
                    mem.confidence,
                    mem.root_cause,
                    mem.fix_summary,
                    mem.files_fixed.join(", "),
                    if mem.fix_worked { "yes" } else { "no" },
                ));
            }
            return Ok(out);
        }
    }

    // No recording, no memory — return alert context only
    Ok(serde_json::to_string_pretty(&json!({
        "alert_id": alert_id,
        "title": alert.title,
        "body": alert.body,
        "severity": alert.severity,
        "project": alert.project,
        "sources": alert.source_integrations,
        "fingerprint": alert.fingerprint,
        "substrate_recording": null,
        "note": "No substrate recording found. Enable substrate in @inariwatch/capture: INARIWATCH_SUBSTRATE=true"
    }))?)
}

fn format_substrate_response(alert_title: &str, body: &Value) -> anyhow::Result<String> {
    let recording_id = body["recordingId"].as_str().unwrap_or("unknown");
    let command = body["command"].as_str().unwrap_or("unknown");
    let runtime = body["runtime"].as_str().unwrap_or("node");
    let event_count = body["eventCount"].as_u64().unwrap_or(0);
    let duration_ms = body["durationMs"].as_u64().unwrap_or(0);
    let context = body["context"].as_str().unwrap_or("");

    let mut out = format!(
        "Substrate I/O recording for: {}\n{}\n\n",
        alert_title,
        "=".repeat(50)
    );
    out.push_str(&format!(
        "Recording: {}\nCommand: {}\nRuntime: {}\nEvents: {} I/O operations\nDuration: {}ms\n\n",
        recording_id, command, runtime, event_count, duration_ms
    ));

    if !context.is_empty() {
        out.push_str(&format!("Context summary:\n{}\n\n", context));
    }

    if let Some(categories) = body["categories"].as_object() {
        out.push_str("I/O categories:\n");
        for (cat, count) in categories {
            out.push_str(&format!("  • {}: {}\n", cat, count));
        }
        out.push('\n');
    }

    Ok(out)
}
