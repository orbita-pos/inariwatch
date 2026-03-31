use serde_json::{json, Value};
use std::time::Instant;

use crate::config;

/// Live uptime check for all configured uptime monitors (or a specific project).
pub async fn execute(args: &Value) -> anyhow::Result<String> {
    let project_filter = args["project"].as_str();

    let cfg = config::load()?;
    if cfg.projects.is_empty() {
        return Ok("No projects configured.".to_string());
    }

    let projects: Vec<_> = cfg
        .projects
        .iter()
        .filter(|p| {
            project_filter
                .map(|f| p.slug == f || p.name == f)
                .unwrap_or(true)
        })
        .filter(|p| p.integrations.uptime.is_some())
        .collect();

    if projects.is_empty() {
        return Ok(
            "No uptime monitors configured. Add one with `inariwatch add uptime`.".to_string(),
        );
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;

    let mut results = Vec::new();

    for project in &projects {
        let uptime_cfg = project.integrations.uptime.as_ref().unwrap();
        let url = &uptime_cfg.url;

        let start = Instant::now();
        let check = client.get(url).send().await;
        let elapsed_ms = start.elapsed().as_millis() as u64;

        let (status_code, is_up, error) = match check {
            Ok(resp) => {
                let code = resp.status().as_u16();
                let up = code == uptime_cfg.expected_status;
                (Some(code), up, None)
            }
            Err(e) => {
                let reason = if e.is_timeout() {
                    format!("timeout after {}s", uptime_cfg.timeout_secs)
                } else if e.is_connect() {
                    "connection refused".to_string()
                } else {
                    e.to_string()
                };
                (None, false, Some(reason))
            }
        };

        results.push(json!({
            "project": project.name,
            "url": url,
            "is_up": is_up,
            "status_code": status_code,
            "response_time_ms": elapsed_ms,
            "expected_status": uptime_cfg.expected_status,
            "error": error,
        }));
    }

    // Format output
    let all_up = results.iter().all(|r| r["is_up"].as_bool().unwrap_or(false));
    let header = if all_up {
        "✓ All systems operational"
    } else {
        "✗ Degraded — one or more monitors are down"
    };

    let mut out = format!("{}\n{}\n\n", header, "=".repeat(40));

    for r in &results {
        let project = r["project"].as_str().unwrap_or("");
        let url = r["url"].as_str().unwrap_or("");
        let is_up = r["is_up"].as_bool().unwrap_or(false);
        let status = r["status_code"].as_u64();
        let ms = r["response_time_ms"].as_u64().unwrap_or(0);

        let status_str = if let Some(code) = status {
            format!("HTTP {}", code)
        } else {
            r["error"]
                .as_str()
                .unwrap_or("unknown error")
                .to_string()
        };

        out.push_str(&format!(
            "{} {} — {}\n   URL: {}\n   Response: {}ms\n\n",
            if is_up { "✓" } else { "✗" },
            project,
            status_str,
            url,
            ms,
        ));
    }

    Ok(out)
}
