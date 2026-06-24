pub mod prompts;

use anyhow::Result;
use ai_router_rs::{
    dispatch, detect_provider as router_detect, AIMessage, AIProvider, DispatchInput, TaskName,
};

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

/// Correlate raw events into a single alert. Originally hand-rolled
/// `call_claude` / `call_openai`; v0.3 S7 routes through `ai-router-rs`
/// with `TaskName::AlertCorrelate`.
pub async fn analyze(
    global: &GlobalConfig,
    events: &[RawEvent],
) -> Result<Option<AiAnalysis>> {
    let key = match &global.ai_key {
        Some(k) => k.as_str(),
        None => return Ok(None),
    };

    let prompt = build_correlation_prompt(events);
    let messages = vec![AIMessage::user(prompt)];
    let mut input = DispatchInput::new(
        TaskName::AlertCorrelate,
        key,
        "", // legacy correlation prompt embeds its own instructions
        &messages,
        512,
    );
    input.model = Some(global.ai_model.as_str()).filter(|m| !m.is_empty());
    let resp = dispatch(input).await?;
    Ok(Some(parse_response(&resp.text)))
}

// ── v2: Configurable AI calls ────────────────────────────────────────────────

/// Detect the AI provider from the API key prefix. Thin wrapper over
/// the router's [`router_detect`] so callers do not need to import the
/// router type directly.
pub fn detect_provider(key: &str) -> Provider {
    Provider::from_router(router_detect(key))
}

/// Mirror of the router's [`AIProvider`] surface, kept in the cli crate
/// so existing call sites that match on `Provider` still compile. New
/// code should prefer the router's enum directly.
#[derive(Debug, Clone, Copy)]
pub enum Provider {
    Claude,
    OpenAI,
    Grok,
    Gemini,
}

impl Provider {
    fn from_router(r: AIProvider) -> Self {
        match r {
            AIProvider::Claude => Provider::Claude,
            AIProvider::Grok => Provider::Grok,
            AIProvider::Gemini => Provider::Gemini,
            // Groq + DeepSeek + Together collapse to OpenAI for cli's
            // coarser taxonomy; the router still routes them correctly
            // via `detect_provider` on the api_key prefix.
            AIProvider::Openai
            | AIProvider::Groq
            | AIProvider::Deepseek
            | AIProvider::Together => Provider::OpenAI,
        }
    }

    /// Default model for this provider.
    pub fn default_model(&self) -> &'static str {
        match self {
            Provider::Claude => "claude-haiku-4-5-20251001",
            Provider::OpenAI => "gpt-4o-mini",
            Provider::Grok => "grok-3-mini-beta",
            Provider::Gemini => "gemini-2.0-flash",
        }
    }
}

/// Generic AI call with configurable parameters. Delegates to
/// `ai-router-rs` `dispatch()` — the actual HTTP call (and the URL
/// strings that drive it) live inside the router crate.
pub async fn call_ai(
    key: &str,
    model: Option<&str>,
    system: &str,
    prompt: &str,
    max_tokens: u32,
) -> Result<String> {
    call_ai_with_task(TaskName::CodeFingerprint, key, model, system, prompt, max_tokens).await
}

/// Same as [`call_ai`] but with explicit task taxonomy. Receipts get the
/// correct task attribution; `/admin/ops` cost columns line up with the
/// caller's intent.
pub async fn call_ai_with_task(
    task: TaskName,
    key: &str,
    model: Option<&str>,
    system: &str,
    prompt: &str,
    max_tokens: u32,
) -> Result<String> {
    let messages = vec![AIMessage::user(prompt.to_string())];
    let mut input = DispatchInput::new(task, key, system, &messages, max_tokens);
    input.model = model;
    let resp = dispatch(input).await?;
    Ok(resp.text)
}

/// Call AI and parse the response as JSON, stripping markdown fences.
pub async fn call_ai_json(
    key: &str,
    model: Option<&str>,
    system: &str,
    prompt: &str,
    max_tokens: u32,
) -> Result<serde_json::Value> {
    call_ai_json_with_task(
        TaskName::CodeFingerprint,
        key,
        model,
        system,
        prompt,
        max_tokens,
    )
    .await
}

pub async fn call_ai_json_with_task(
    task: TaskName,
    key: &str,
    model: Option<&str>,
    system: &str,
    prompt: &str,
    max_tokens: u32,
) -> Result<serde_json::Value> {
    let text = call_ai_with_task(task, key, model, system, prompt, max_tokens).await?;
    let clean = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    serde_json::from_str(clean).map_err(|e| {
        anyhow::anyhow!(
            "Failed to parse AI response as JSON: {}. Raw: {}",
            e,
            &clean[..clean.len().min(200)]
        )
    })
}

// ── v2: High-level AI functions ──────────────────────────────────────────────

/// Diagnose an alert and identify files to read (step 2 of trigger_fix).
#[allow(clippy::too_many_arguments)]
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
    call_ai_json_with_task(
        TaskName::CodeFixSingleShot,
        key,
        model,
        prompts::SYSTEM_REMEDIATOR,
        &prompt,
        600,
    )
    .await
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
    call_ai_json_with_task(
        TaskName::CodeFixSingleShot,
        key,
        model,
        prompts::SYSTEM_REMEDIATOR,
        &prompt,
        4096,
    )
    .await
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
    let prompt =
        prompts::build_self_review_prompt(diagnosis, original_files, fixed_files, error_details);
    call_ai_json_with_task(
        TaskName::CodeReviewSelf,
        key,
        model,
        prompts::SYSTEM_REVIEWER,
        &prompt,
        1024,
    )
    .await
}

/// Generate a post-mortem document after successful remediation.
#[allow(clippy::too_many_arguments)]
pub async fn generate_postmortem(
    key: &str,
    model: Option<&str>,
    alert_title: &str,
    alert_body: &str,
    alert_sources: &[String],
    alert_severity: &str,
    alert_created_at: &str,
    diagnosis: &str,
    fix_explanation: &str,
    files_changed: &[String],
    confidence: u32,
    pr_url: Option<&str>,
    auto_merged: bool,
    steps: &[(String, String)],
) -> Result<String> {
    let prompt = prompts::build_postmortem_prompt(
        alert_title,
        alert_body,
        alert_sources,
        alert_severity,
        alert_created_at,
        diagnosis,
        fix_explanation,
        files_changed,
        confidence,
        pr_url,
        auto_merged,
        steps,
    );
    call_ai_with_task(
        TaskName::NotifyComposePostmortemProse,
        key,
        model,
        prompts::SYSTEM_POSTMORTEM,
        &prompt,
        2048,
    )
    .await
}

// ── Prompt builder (v1 — existing) ──────────────────────────────────────────

fn build_correlation_prompt(events: &[RawEvent]) -> String {
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

fn parse_response(text: &str) -> AiAnalysis {
    let clean = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let v: serde_json::Value =
        serde_json::from_str(clean).unwrap_or_else(|_| serde_json::json!({}));

    AiAnalysis {
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
    }
}
