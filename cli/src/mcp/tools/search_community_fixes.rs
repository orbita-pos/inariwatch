use serde_json::Value;

use crate::config;

/// Search the InariWatch community fix network for known fixes matching a query.
/// Calls GET {fix_replay_url}/api/patterns/search?q=<query>
pub async fn execute(args: &Value) -> anyhow::Result<String> {
    let query = args["query"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("query is required"))?;
    let limit = args["limit"].as_u64().unwrap_or(5).min(20) as usize;

    let cfg = config::load()?;
    let base_url = cfg
        .global
        .fix_replay_url
        .as_deref()
        .unwrap_or("https://app.inariwatch.com");

    let encoded_q = urlencoding::encode(query);
    let url = format!(
        "{}/api/patterns/search?q={}",
        base_url.trim_end_matches('/'),
        encoded_q
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;

    let resp = client.get(&url).send().await?;
    if !resp.status().is_success() {
        return Ok(format!(
            "Community fix network unavailable (HTTP {}). Is fix_replay_url configured correctly?",
            resp.status()
        ));
    }

    let body: Value = resp.json().await?;

    let matches = match body["matches"].as_array() {
        Some(m) if !m.is_empty() => m,
        _ => return Ok(format!("No community fixes found for: {}", query)),
    };

    let mut out = format!(
        "Community fixes for \"{}\"\n{}\n\n",
        query,
        "=".repeat(50)
    );

    for (i, m) in matches.iter().take(limit).enumerate() {
        let pattern_text = m["pattern"]["patternText"].as_str().unwrap_or("Unknown pattern");
        let category = m["pattern"]["category"].as_str().unwrap_or("unknown");
        let framework = m["pattern"]["framework"].as_str().unwrap_or("");
        let language = m["pattern"]["language"].as_str().unwrap_or("");

        out.push_str(&format!(
            "{}. Pattern: {}\n   Category: {}",
            i + 1,
            pattern_text,
            category
        ));
        if !framework.is_empty() {
            out.push_str(&format!(" | Framework: {}", framework));
        }
        if !language.is_empty() {
            out.push_str(&format!(" | Language: {}", language));
        }
        out.push('\n');

        if let Some(fixes) = m["fixes"].as_array() {
            for fix in fixes.iter().take(3) {
                let approach = fix["fixApproach"].as_str().unwrap_or("");
                let description = fix["fixDescription"].as_str().unwrap_or("");
                let success = fix["successCount"].as_u64().unwrap_or(0);
                let total = fix["totalApplications"].as_u64().unwrap_or(0);
                let confidence = fix["avgConfidence"].as_u64().unwrap_or(0);
                let success_pct = if total > 0 {
                    format!("{}% success ({}/{})", success * 100 / total, success, total)
                } else {
                    "new fix".to_string()
                };

                out.push_str(&format!(
                    "   Fix: [{}] {} — {}\n        Confidence: {}% | {}\n",
                    approach, description, "", confidence, success_pct
                ));
            }
        }
        out.push('\n');
    }

    Ok(out)
}
