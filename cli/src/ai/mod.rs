pub mod prompts;

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

// ── v2: Configurable AI calls ────────────────────────────────────────────────

/// Detect the AI provider from the API key prefix.
/// Ported from web/lib/ai/client.ts detectProvider().
pub fn detect_provider(key: &str) -> Provider {
    if key.starts_with("sk-ant-") {
        Provider::Claude
    } else if key.starts_with("gsk_") {
        Provider::Grok
    } else if key.starts_with("AIza") {
        Provider::Gemini
    } else if key.starts_with("sk-") && key.len() > 40 {
        // DeepSeek keys are also sk- but tend to be shorter
        Provider::OpenAI
    } else {
        // Default to OpenAI-compatible for unknown prefixes
        Provider::OpenAI
    }
}

#[derive(Debug, Clone, Copy)]
pub enum Provider {
    Claude,
    OpenAI,
    Grok,
    Gemini,
}

impl Provider {
    /// Default model for this provider.
    pub fn default_model(&self) -> &'static str {
        match self {
            Provider::Claude => "claude-haiku-4-5-20251001",
            Provider::OpenAI => "gpt-4o-mini",
            Provider::Grok => "grok-3-mini-beta",
            Provider::Gemini => "gemini-2.0-flash",
        }
    }

    /// API base URL.
    fn api_url(&self) -> &'static str {
        match self {
            Provider::Claude => "https://api.anthropic.com/v1/messages",
            Provider::OpenAI => "https://api.openai.com/v1/chat/completions",
            Provider::Grok => "https://api.x.ai/v1/chat/completions",
            Provider::Gemini => "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        }
    }
}

/// Generic AI call with configurable parameters.
/// Returns the raw text response from the model.
pub async fn call_ai(
    key: &str,
    model: Option<&str>,
    system: &str,
    prompt: &str,
    max_tokens: u32,
) -> Result<String> {
    let provider = detect_provider(key);
    let model = model.unwrap_or(provider.default_model());

    match provider {
        Provider::Claude => call_claude_raw(key, model, system, prompt, max_tokens).await,
        _ => call_openai_compat(key, provider.api_url(), model, system, prompt, max_tokens).await,
    }
}

/// Call AI and parse the response as JSON, stripping markdown fences.
pub async fn call_ai_json(
    key: &str,
    model: Option<&str>,
    system: &str,
    prompt: &str,
    max_tokens: u32,
) -> Result<serde_json::Value> {
    let text = call_ai(key, model, system, prompt, max_tokens).await?;
    let clean = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    serde_json::from_str(clean)
        .map_err(|e| anyhow::anyhow!("Failed to parse AI response as JSON: {}. Raw: {}", e, &clean[..clean.len().min(200)]))
}

// ── v2: High-level AI functions ──────────────────────────────────────────────

/// Deep root cause analysis for get_root_cause tool.
pub async fn deep_analyze(
    key: &str,
    model: Option<&str>,
    alert_title: &str,
    alert_body: &str,
    alert_sources: &[String],
    context: &prompts::RemediationContext,
) -> Result<serde_json::Value> {
    let prompt = prompts::build_deep_analyze_prompt(
        alert_title,
        alert_body,
        alert_sources,
        context,
    );
    call_ai_json(key, model, prompts::SYSTEM_DEEP_ANALYZER, &prompt, 800).await
}

/// Diagnose an alert and identify files to read (step 2 of trigger_fix).
pub async fn diagnose(
    key: &str,
    model: Option<&str>,
    alert_title: &str,
    alert_body: &str,
    alert_sources: &[String],
    repo_files: &[String],
    context: &prompts::RemediationContext,
    ai_reasoning: Option<&str>,
    past_incidents: &[prompts::MemoryHint],
) -> Result<serde_json::Value> {
    let prompt = prompts::build_diagnose_prompt(
        alert_title,
        alert_body,
        alert_sources,
        repo_files,
        context,
        ai_reasoning,
        past_incidents,
    );
    call_ai_json(key, model, prompts::SYSTEM_REMEDIATOR, &prompt, 600).await
}

/// Generate a code fix (step 4 of trigger_fix).
pub async fn generate_fix(
    key: &str,
    model: Option<&str>,
    diagnosis: &str,
    files: &[(&str, &str)],
    error_details: &str,
    previous_attempt: Option<(&[String], &str)>,
) -> Result<serde_json::Value> {
    let prompt = prompts::build_fix_prompt(diagnosis, files, error_details, previous_attempt);
    call_ai_json(key, model, prompts::SYSTEM_REMEDIATOR, &prompt, 4096).await
}

/// Self-review a generated fix (step 5 of trigger_fix).
pub async fn self_review(
    key: &str,
    model: Option<&str>,
    diagnosis: &str,
    original_files: &[(&str, &str)],
    fixed_files: &[(&str, &str)],
    error_details: &str,
) -> Result<serde_json::Value> {
    let prompt = prompts::build_self_review_prompt(diagnosis, original_files, fixed_files, error_details);
    call_ai_json(key, model, prompts::SYSTEM_REVIEWER, &prompt, 1024).await
}

/// Generate a post-mortem document after successful remediation.
pub async fn generate_postmortem(
    key: &str,
    model: Option<&str>,
    alert_title: &str,
    alert_body: &str,
    alert_sources: &[String],
    diagnosis: &str,
    fix_explanation: &str,
    files_changed: &[String],
    confidence: u32,
    pr_url: Option<&str>,
    auto_merged: bool,
    steps: &[(String, String)],
) -> Result<String> {
    let prompt = prompts::build_postmortem_prompt(
        alert_title, alert_body, alert_sources,
        diagnosis, fix_explanation, files_changed,
        confidence, pr_url, auto_merged, steps,
    );
    call_ai(key, model, prompts::SYSTEM_POSTMORTEM, &prompt, 2048).await
}

/// Pre-deploy risk assessment for a pull request.
/// Returns markdown-formatted risk assessment.
pub async fn assess_risk(
    key: &str,
    model: Option<&str>,
    ctx: &prompts::RiskContext,
) -> Result<String> {
    let prompt = prompts::build_risk_assessment_prompt(ctx);
    call_ai(key, model, prompts::SYSTEM_RISK_ASSESSOR, &prompt, 1024).await
}

// ── Prompt builder (v1 — existing) ──────────────────────────────────────────

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

// ── Claude (v2 — with system prompt + configurable max_tokens) ──────────────

async fn call_claude_raw(
    key: &str,
    model: &str,
    system: &str,
    prompt: &str,
    max_tokens: u32,
) -> Result<String> {
    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&serde_json::json!({
            "model": model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": prompt}]
        }))
        .send()
        .await?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("Claude API error: {}", body);
    }

    let raw: ClaudeResponse = resp.json().await?;
    Ok(raw.content.first().map(|b| b.text.clone()).unwrap_or_default())
}

// ── OpenAI-compatible (v2 — works for OpenAI, Grok, Gemini) ────────────────

async fn call_openai_compat(
    key: &str,
    api_url: &str,
    model: &str,
    system: &str,
    prompt: &str,
    max_tokens: u32,
) -> Result<String> {
    let client = reqwest::Client::new();

    let auth_header = if api_url.contains("googleapis.com") {
        // Gemini uses API key as query param, but also accepts Bearer
        format!("Bearer {}", key)
    } else {
        format!("Bearer {}", key)
    };

    let resp = client
        .post(api_url)
        .header("Authorization", &auth_header)
        .json(&serde_json::json!({
            "model": model,
            "max_tokens": max_tokens,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt}
            ]
        }))
        .send()
        .await?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("AI API error ({}): {}", api_url, body);
    }

    let raw: OpenAIResponse = resp.json().await?;
    Ok(raw
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .unwrap_or_default())
}

// ── v1 legacy wrappers (kept for backwards compat with analyze()) ───────────

async fn call_claude(key: &str, model: &str, prompt: &str) -> Result<AiAnalysis> {
    let text = call_claude_raw(key, model, "", prompt, 512).await?;
    parse_response(&text)
}

async fn call_openai(key: &str, prompt: &str) -> Result<AiAnalysis> {
    let text = call_openai_compat(
        key,
        "https://api.openai.com/v1/chat/completions",
        "gpt-4o-mini",
        "",
        prompt,
        512,
    )
    .await?;
    parse_response(&text)
}

// ── Response types ───────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ClaudeResponse {
    content: Vec<ClaudeBlock>,
}

#[derive(Deserialize)]
struct ClaudeBlock {
    text: String,
}

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

fn parse_response(text: &str) -> Result<AiAnalysis> {
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
