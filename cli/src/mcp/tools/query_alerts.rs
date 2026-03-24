use serde_json::Value;

use crate::db;

pub async fn execute(args: &Value) -> anyhow::Result<String> {
    let requested_limit = args["limit"].as_u64().unwrap_or(20).min(100) as usize;
    let project = args["project"].as_str();
    let severity_filter = args["severity"].as_str();

    // When filtering by severity, fetch more rows so we can return
    // up to `requested_limit` after filtering.
    let fetch_limit = if severity_filter.is_some() {
        (requested_limit * 5).min(500)
    } else {
        requested_limit
    };

    let conn = db::open()?;
    let mut alerts = db::get_recent_alerts(&conn, project, fetch_limit)?;
    if let Some(sev) = severity_filter {
        alerts.retain(|a| a.severity == sev);
    }
    alerts.truncate(requested_limit);

    if alerts.is_empty() {
        return Ok("No alerts found.".to_string());
    }

    let mut out = format!("{} alert(s):\n\n", alerts.len());
    for a in &alerts {
        out.push_str(&format!(
            "[{}] {} — {}\n{}\nSources: {}\nTime: {}\n\n",
            a.severity.to_uppercase(),
            a.project,
            a.title,
            a.body,
            a.source_integrations.join(", "),
            a.created_at.format("%Y-%m-%d %H:%M UTC"),
        ));
    }
    Ok(out)
}
