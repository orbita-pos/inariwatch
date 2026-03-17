use anyhow::Result;
use serde::Deserialize;

use crate::config::GlobalConfig;
use crate::orchestrator::RawEvent;

// ── Public interface ──────────────────────────────────────────────────────────

pub struct AiAnalysis {
    pub severity: String,
    pub title: String,
    pub body: String,
    pub root_cause: Option<String>,
    pub suggested_action: Option<String>,
}

/// Call Claude or OpenAI depending on the key prefix.
/// Returns None if no AI key is configured.
pub async fn analyze(
    global: &GlobalConfig,
    events: &[RawEvent],
) -> Result<Option<AiAnalysis>> {
    let key = match &global.ai_key {
        Some(k) => k.as_str(),
        None => return Ok(None),
    };

    let prompt = build_prompt(events);

    let analysis = if key.starts_with("sk-ant-") {
        call_claude(key, &global.ai_model, &prompt).await?
    } else {
        call_openai(key, &prompt).await?
    };

    Ok(Some(analysis))
}

// ── Prompt builder ────────────────────────────────────────────────────────────

fn build_prompt(events: &[RawEvent]) -> String {
    let mut lines = vec![
        "You are a developer monitoring assistant. \
         Correlate the events below and produce one concise alert."
            .to_string(),
        String::new(),
        "EVENTS:".to_string(),
    ];

    for e in events {
        lines.push(format!(
            "[{}] {} at {}",
            e.integration.to_uppercase(),
            e.event_type,
            e.occurred_at.format("%H:%M UTC")
        ));
        for line in e.detail.lines() {
            lines.push(format!("  {}", line));
        }
        if let Some(url) = &e.url {
            lines.push(format!("  → {}", url));
        }
    }

    lines.push(String::new());
    lines.push(
        "Respond ONLY as JSON (no markdown fences), using this exact schema:".to_string(),
    );
    lines.push(
        r#"{"severity":"critical|warning|info","title":"≤60 chars","body":"≤280 chars","root_cause":"1 sentence","suggested_action":"concrete next step"}"#
            .to_string(),
    );

    lines.join("\n")
}

// ── Claude ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ClaudeResponse {
    content: Vec<ClaudeBlock>,
}

#[derive(Deserialize)]
struct ClaudeBlock {
    text: String,
}

async fn call_claude(key: &str, model: &str, prompt: &str) -> Result<AiAnalysis> {
    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&serde_json::json!({
            "model": model,
            "max_tokens": 512,
            "messages": [{"role": "user", "content": prompt}]
        }))
        .send()
        .await?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("Claude API error: {}", body);
    }

    let raw: ClaudeResponse = resp.json().await?;
    let text = raw.content.first().map(|b| b.text.as_str()).unwrap_or("{}");
    parse_response(text)
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct OpenAIResponse {
    choices: Vec<OpenAIChoice>,
}

#[derive(Deserialize)]
struct OpenAIChoice {
    message: OpenAIMessage,
}

#[derive(Deserialize)]
struct OpenAIMessage {
    content: String,
}

async fn call_openai(key: &str, prompt: &str) -> Result<AiAnalysis> {
    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", key))
        .json(&serde_json::json!({
            "model": "gpt-4o-mini",
            "max_tokens": 512,
            "messages": [{"role": "user", "content": prompt}]
        }))
        .send()
        .await?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("OpenAI API error: {}", body);
    }

    let raw: OpenAIResponse = resp.json().await?;
    let text = raw
        .choices
        .first()
        .map(|c| c.message.content.as_str())
        .unwrap_or("{}");
    parse_response(text)
}

// ── Response parser ───────────────────────────────────────────────────────────

fn parse_response(text: &str) -> Result<AiAnalysis> {
    // Strip markdown code fences if the model forgot
    let clean = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let v: serde_json::Value =
        serde_json::from_str(clean).unwrap_or_else(|_| serde_json::json!({}));

    Ok(AiAnalysis {
        severity: v["severity"]
            .as_str()
            .unwrap_or("warning")
            .to_string(),
        title: v["title"]
            .as_str()
            .unwrap_or("New alert")
            .to_string(),
        body: v["body"].as_str().unwrap_or(clean).to_string(),
        root_cause: v["root_cause"].as_str().map(String::from),
        suggested_action: v["suggested_action"].as_str().map(String::from),
    })
}
