//! v0.3 S4 — `notify.compose.slack` handler.
//!
//! Mirror of the email handler in this module's `mod.rs` but emits Slack
//! Block-Kit JSON instead of plain prose. Per `INARI_AI_ARCHITECTURE.md`
//! §1: the local model writes the human-facing prose; deterministic
//! cloud-side code (`web/lib/slack/blocks.ts`) keeps owning the layout
//! shell. The output here is a `{text, blocks}` pair the cloud bot can
//! pass straight to `chat.postMessage`. Only the prose inside
//! `blocks[].text.text` actually rides the local model.
//!
//! ## Pipeline
//!
//! Same as email — see `mod.rs` doc comment. Differences:
//! - Prompt asks for Block-Kit JSON, not flat prose.
//! - Parser pulls `text` (mobile preview fallback) + `blocks` (rendered
//!   payload) out of the model output. `text` is hard-clipped at 200
//!   chars to match Slack mobile preview behavior.

use std::sync::Arc;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use crate::local_ai::{GenerateOptions, LocalAI};

use super::{AlertContext, ComposeError, UsageHint};

/// Default model id. Same Qwen-Coder-1.5B as email — instruction-follows
/// JSON well at low temperature. S5+ may swap per-channel if eval scores
/// suggest a different default.
pub const DEFAULT_MODEL_ID: &str = "qwen2.5-coder-1.5b";

/// Slack section text caps at 3000 chars but we target much shorter — a
/// notification, not a wiki page. The model is told to keep blocks short
/// and we hard-clip the preview text on output to be safe.
pub const MAX_TOKENS: u32 = 512;

/// Same low temperature as the email handler — instruction following
/// matters more than creativity.
pub const TEMPERATURE: f32 = 0.3;

/// Slack mobile previews truncate at ~200 chars. We clip on the way out
/// so cross-substrate scoring doesn't pick up a length artifact.
pub const TEXT_PREVIEW_CAP_CHARS: usize = 200;

// ── Request shape ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ComposeSlackRequest {
    pub alert: AlertContext,
    #[serde(default = "default_recipient_role")]
    pub recipient_role: String,
    #[serde(default = "default_tone")]
    pub tone: String,
    #[serde(default = "default_language")]
    pub language: String,
    /// Optional channel hint (e.g. "#alerts-prod"). Surfaces in the prompt
    /// so the model can address it appropriately. The actual delivery
    /// channel is decided cloud-side; this is purely advisory tone input.
    #[serde(default)]
    pub channel_hint: Option<String>,
    /// When true, the prompt allows `<!here>` for high-severity alerts.
    /// Default false — most workspaces opt-in per channel.
    #[serde(default)]
    pub allow_here_mention: bool,
    /// Optional explicit model override.
    #[serde(default)]
    pub model: Option<String>,
}

fn default_recipient_role() -> String {
    "developer".into()
}
fn default_tone() -> String {
    "concise".into()
}
fn default_language() -> String {
    "en".into()
}

// ── Response shape ─────────────────────────────────────────────────────────

/// What the dispatch carries back. `text` is the mobile-preview fallback;
/// `blocks` is the Block-Kit JSON the bot posts. Slack's API requires both.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComposeSlackResponse {
    pub text: String,
    pub blocks: Vec<serde_json::Value>,
    pub model: String,
    pub usage: UsageHint,
}

// ── Prompt template ────────────────────────────────────────────────────────

/// Build the prompt the local model sees. Aligned byte-for-byte with the
/// cloud-side counterpart the eval harness uses — keeps cross-substrate
/// scores comparable without confounding the model with prompt drift.
pub fn build_prompt(req: &ComposeSlackRequest) -> String {
    let language_label = match req.language.as_str() {
        "es" => "Spanish",
        _ => "English",
    };
    let tone_guidance = match req.tone.as_str() {
        "detailed" => "include a 2-3 sentence context paragraph in the section block",
        _ => "be concise — the section text should be 2 short sentences max",
    };
    let role_guidance = match req.recipient_role.as_str() {
        "manager" => "Frame impact in business terms; avoid stack traces and code-level detail.",
        "stakeholder" => "Plain language; explain what users see, no internal jargon.",
        _ => "Technical detail OK; reference stack-trace fragments when useful.",
    };
    let mention_guidance = if req.allow_here_mention {
        "If severity is `critical`, you MAY include `<!here>` as the first token of the section text. Otherwise do NOT include any channel mentions."
    } else {
        "Do NOT include any channel mentions (`<!here>`, `<!channel>`)."
    };
    let alert_title = req.alert.title.trim();
    let severity = if req.alert.severity.is_empty() {
        "unknown"
    } else {
        req.alert.severity.as_str()
    };
    let source = if req.alert.source.is_empty() {
        "monitoring"
    } else {
        req.alert.source.as_str()
    };
    let message = req.alert.message.as_deref().unwrap_or("(no detail)");
    let url = req.alert.url.as_deref().unwrap_or("");
    let channel = req
        .channel_hint
        .as_deref()
        .unwrap_or("(channel unknown)");

    format!(
        r#"You are an incident notifier composing a Slack Block-Kit message.

Language: {language_label}.
Tone: {tone_guidance}.
Recipient role: {recipient_role}. {role_guidance}
Channel hint: {channel}. {mention_guidance}

Alert title: {alert_title}
Severity: {severity}
Source: {source}
Detail: {message}
Link: {url}

Slack mrkdwn rules — escape `&` as `&amp;`, `<` as `&lt;`, `>` as `&gt;` only when they appear as literal text. Use `*bold*` (single asterisks), `_italic_`, `\`code\``, and `<url|label>` for links. Never wrap output in markdown fences.

Respond with strict JSON, exactly this shape and no commentary or markdown fences:
{{"text": "<plain-text fallback for mobile previews, <=140 chars>", "blocks": [{{"type": "section", "text": {{"type": "mrkdwn", "text": "<the body — Slack mrkdwn allowed>"}}}}]}}
"#,
        recipient_role = req.recipient_role,
    )
}

// ── Response parser ────────────────────────────────────────────────────────

/// Extract `text` and `blocks` from raw model output. Same brace-balanced
/// JSON extraction as the email parser handles fenced output and prefix
/// prose. The text field is hard-clipped at [`TEXT_PREVIEW_CAP_CHARS`] so
/// Slack mobile previews aren't truncated mid-codepoint.
pub fn parse_response(raw: &str) -> Result<ComposeSlackResponse, ComposeError> {
    let json_text = super::extract_json_object(raw)
        .ok_or_else(|| ComposeError::Malformed(super::truncate_for_log(raw)))?;
    let v: serde_json::Value = serde_json::from_str(&json_text).map_err(|e| {
        ComposeError::Malformed(format!("{}: {}", e, super::truncate_for_log(&json_text)))
    })?;

    let text = v
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let blocks = v
        .get("blocks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if text.is_empty() && blocks.is_empty() {
        return Err(ComposeError::Malformed(super::truncate_for_log(raw)));
    }

    let text = clip_preview_text(&text);

    Ok(ComposeSlackResponse {
        text,
        blocks,
        model: String::new(),
        usage: UsageHint::default(),
    })
}

/// Clip on Unicode char boundary so we never split a codepoint. Appends
/// the standard ellipsis if anything was trimmed. Pure function — exposed
/// for unit tests of the truncation contract.
pub fn clip_preview_text(text: &str) -> String {
    if text.chars().count() <= TEXT_PREVIEW_CAP_CHARS {
        return text.to_string();
    }
    let mut out = String::with_capacity(TEXT_PREVIEW_CAP_CHARS + 4);
    for (i, c) in text.chars().enumerate() {
        if i >= TEXT_PREVIEW_CAP_CHARS {
            break;
        }
        out.push(c);
    }
    out.push('…');
    out
}

// ── Local AI invocation ────────────────────────────────────────────────────

/// Compose a Slack message by streaming tokens from the local AI runtime.
pub async fn compose_slack(
    local_ai: &Arc<LocalAI>,
    request: ComposeSlackRequest,
) -> Result<ComposeSlackResponse, ComposeError> {
    let model_id = request
        .model
        .clone()
        .unwrap_or_else(|| DEFAULT_MODEL_ID.to_string());
    let prompt = build_prompt(&request);
    let approx_input_tokens = (prompt.len() / 4) as u32;

    let opts = GenerateOptions {
        model_id: model_id.clone(),
        prompt,
        max_tokens: MAX_TOKENS,
        stop_seqs: vec![],
        fim_mode: false,
        temperature: Some(TEMPERATURE),
    };
    let mut stream = local_ai.generate(opts).await?;
    let mut accumulated = String::new();
    while let Some(token) = stream.next().await {
        let tok = token?;
        accumulated.push_str(&tok.text);
        if tok.finish_reason.is_some() {
            break;
        }
    }
    let approx_output_tokens = (accumulated.len() / 4) as u32;
    let mut parsed = parse_response(&accumulated)?;
    parsed.model = model_id;
    parsed.usage = UsageHint {
        input_tokens: approx_input_tokens,
        output_tokens: approx_output_tokens,
    };
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_request() -> ComposeSlackRequest {
        ComposeSlackRequest {
            alert: AlertContext {
                title: "Stripe webhook returned 503".into(),
                severity: "critical".into(),
                source: "vercel".into(),
                message: Some("Function timeout after 10s on /api/webhooks/stripe".into()),
                url: Some("https://app.inariwatch.com/alerts/abc".into()),
            },
            recipient_role: "developer".into(),
            tone: "concise".into(),
            language: "en".into(),
            channel_hint: Some("#alerts-prod".into()),
            allow_here_mention: false,
            model: None,
        }
    }

    #[test]
    fn build_prompt_includes_alert_and_channel_hint() {
        let prompt = build_prompt(&sample_request());
        assert!(prompt.contains("Stripe webhook"));
        assert!(prompt.contains("#alerts-prod"));
        assert!(prompt.contains("critical"));
        assert!(prompt.contains("Slack mrkdwn rules"));
        // The strict-JSON contract is critical — the parser depends on it.
        assert!(prompt.contains(r#"{"text":"#));
        assert!(prompt.contains("blocks"));
    }

    #[test]
    fn build_prompt_blocks_here_mention_when_disabled() {
        let prompt = build_prompt(&sample_request());
        assert!(prompt.contains("Do NOT include any channel mentions"));
    }

    #[test]
    fn build_prompt_allows_here_mention_when_opted_in() {
        let mut req = sample_request();
        req.allow_here_mention = true;
        let prompt = build_prompt(&req);
        assert!(prompt.contains("MAY include"));
        assert!(prompt.contains("<!here>"));
    }

    #[test]
    fn parse_response_handles_pure_json() {
        let raw = r#"{"text":"Stripe down","blocks":[{"type":"section","text":{"type":"mrkdwn","text":"Stripe webhook is returning 503."}}]}"#;
        let parsed = parse_response(raw).unwrap();
        assert_eq!(parsed.text, "Stripe down");
        assert_eq!(parsed.blocks.len(), 1);
        assert_eq!(parsed.blocks[0]["type"], "section");
    }

    #[test]
    fn parse_response_strips_code_fences() {
        let raw = r#"Here's the message:
```json
{"text":"X","blocks":[{"type":"section","text":{"type":"mrkdwn","text":"body"}}]}
```"#;
        let parsed = parse_response(raw).unwrap();
        assert_eq!(parsed.text, "X");
        assert_eq!(parsed.blocks.len(), 1);
    }

    #[test]
    fn parse_response_clips_text_at_200_chars() {
        // Hand-craft a 250-char text — clipping should kick in.
        let long = "a".repeat(250);
        let raw = format!(
            r#"{{"text":"{}","blocks":[{{"type":"section","text":{{"type":"mrkdwn","text":"body"}}}}]}}"#,
            long
        );
        let parsed = parse_response(&raw).unwrap();
        assert_eq!(parsed.text.chars().count(), TEXT_PREVIEW_CAP_CHARS + 1);
        assert!(parsed.text.ends_with('…'));
    }

    #[test]
    fn parse_response_rejects_empty_payload() {
        let raw = r#"{"text":"","blocks":[]}"#;
        let err = parse_response(raw).unwrap_err();
        assert!(matches!(err, ComposeError::Malformed(_)));
    }

    #[test]
    fn parse_response_rejects_no_json() {
        let err = parse_response("nothing here").unwrap_err();
        assert!(matches!(err, ComposeError::Malformed(_)));
    }

    #[test]
    fn clip_preview_text_no_op_when_short() {
        assert_eq!(clip_preview_text("short"), "short");
    }

    #[test]
    fn clip_preview_text_handles_unicode_boundary() {
        // 199 ASCII + 1 multibyte char + suffix — clip should keep the
        // multibyte char intact and append ellipsis.
        let body = format!("{}🎉extra", "a".repeat(199));
        let clipped = clip_preview_text(&body);
        // We kept TEXT_PREVIEW_CAP_CHARS chars; the cap is hit one before the
        // emoji, so the emoji isn't included. Then ellipsis is appended.
        assert_eq!(clipped.chars().count(), TEXT_PREVIEW_CAP_CHARS + 1);
        assert!(clipped.ends_with('…'));
    }
}
