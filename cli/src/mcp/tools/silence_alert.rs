use serde_json::{json, Value};

use crate::db;

pub async fn execute(args: &Value) -> anyhow::Result<String> {
    let alert_id = args["alert_id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("alert_id is required"))?;

    let conn = db::open()?;

    // Check if alert exists and get its current state
    let alert = db::get_alert_by_id(&conn, alert_id)?
        .ok_or_else(|| anyhow::anyhow!("Alert not found: {}", alert_id))?;

    let was_already_read = alert.is_read;

    db::mark_alert_read(&conn, alert_id)?;

    Ok(serde_json::to_string_pretty(&json!({
        "status": "silenced",
        "alert_id": alert_id,
        "title": alert.title,
        "was_already_read": was_already_read
    }))?)
}
