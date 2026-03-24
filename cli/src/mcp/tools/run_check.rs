use serde_json::Value;

use crate::commands::watch;

pub async fn execute(args: &Value) -> anyhow::Result<String> {
    let project_name = args["project"].as_str().map(str::to_string);
    let new_alerts = watch::poll_once(project_name).await?;
    if new_alerts.is_empty() {
        return Ok("✓ All clear — no new alerts.".to_string());
    }
    let mut out = format!("{} new alert(s):\n\n", new_alerts.len());
    for a in &new_alerts {
        out.push_str(&format!(
            "[{}] {}\n{}\nSources: {}\n\n",
            a.severity.to_uppercase(),
            a.title,
            a.body,
            a.source_integrations.join(", "),
        ));
    }
    Ok(out)
}
