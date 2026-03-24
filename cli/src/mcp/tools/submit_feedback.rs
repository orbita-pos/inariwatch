use serde_json::{json, Value};

use crate::db;

/// MCP tool: submit feedback on whether a previous AI fix worked.
pub async fn execute(args: &Value) -> anyhow::Result<String> {
    let memory_id = args["memory_id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("memory_id is required"))?;

    let worked = args["worked"]
        .as_bool()
        .ok_or_else(|| anyhow::anyhow!("worked (boolean) is required"))?;

    let conn = db::open()?;

    // Find and answer any pending feedback for this memory
    let pending = db::get_pending_feedback(&conn, 100)?;
    let matching = pending.iter().find(|fb| fb.memory_id == memory_id);
    if let Some(fb) = matching {
        db::answer_feedback(&conn, &fb.id, worked)?;
    }

    // Update the incident memory directly
    if !worked {
        db::mark_memory_failed(&conn, memory_id)?;
        db::update_memory_confidence(&conn, memory_id, -15)?;
    } else {
        db::update_memory_confidence(&conn, memory_id, 5)?;
    }

    let remaining = db::count_pending_feedback(&conn);

    Ok(serde_json::to_string_pretty(&json!({
        "status": "recorded",
        "memory_id": memory_id,
        "worked": worked,
        "pending_feedback_remaining": remaining,
    }))?)
}
