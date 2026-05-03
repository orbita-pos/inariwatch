//! v0.3 S4 — `notify.compose.push` handler.
//!
//! Mirror of email/slack/telegram for mobile/web push notifications.
//! Per `INARI_AI_ARCHITECTURE.md` §1: prose composed locally, transport
//! (FCM / APNS / Web Push) stays cloud-side. The output here is a
//! payload the cloud-side push sender can flatten into the per-platform
//! envelope.
//!
//! ## Constraints
//!
//! Push notifications are extremely length-sensitive — both APNS and FCM
//! truncate aggressively, and many lockscreens show only a fraction of
//! the body. We enforce hard caps in the parser:
//!   - title: 50 chars
//!   - body:  200 chars
//!   - actions: at most 3 (FCM `notification.actions` cap is loose, but
//!     we cap to 3 to fit on small screens)
//!
//! Bodies that come back longer get clipped on a Unicode boundary with
//! an ellipsis.

use std::sync::Arc;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use crate::local_ai::{GenerateOptions, LocalAI};

use super::{AlertContext, ComposeError, UsageHint};

pub const DEFAULT_MODEL_ID: &str = "qwen2.5-coder-1.5b";
pub const MAX_TOKENS: u32 = 256;
pub const TEMPERATURE: f32 = 0.3;

pub const MAX_TITLE_CHARS: usize = 50;
pub const MAX_BODY_CHARS: usize = 200;
pub const MAX_ACTIONS: usize = 3;

/// Push categories the cloud-side delivery layer understands. The model
/// is allowed to pick one or leave it unset; cloud has a default mapping
/// per severity if unset. Validated post-parse.
pub const ALLOWED_CATEGORIES: &[&str] = &[
    "alert.critical",
    "alert.high",
    "alert.warning",
    "alert.info",
    "deploy.failed",
    "deploy.rolled_back",
    "uptime.down",
    "uptime.recovered",
];

// ── Request shape ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ComposePushRequest {
    pub alert: AlertContext,
    /// Target platform — affects the payload shape on the cloud-side
    /// sender, but here just biases the prompt for tone (Web Push allows
    /// longer bodies than APNS lockscreen).
    #[serde(default = "default_platform")]
    pub platform: String,
    #[serde(default = "default_language")]
    pub language: String,
    /// When true, ask the model to suggest up to 3 quick-action shortcuts
    /// (Ack, Open, Silence). Default true — actions are valuable on
    /// modern OSes and trivially ignored where unsupported.
    #[serde(default = "default_suggest_actions")]
    pub suggest_actions: bool,
    /// Optional explicit model override.
    #[serde(default)]
    pub model: Option<String>,
}

fn default_platform() -> String {
    "ios".into()
}
fn default_language() -> String {
    "en".into()
}
fn default_suggest_actions() -> bool {
    true
}

// ── Response shape ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComposePushResponse {
    pub title: String,
    pub body: String,
    /// Optional 1-3 quick actions. Each `id` is a stable identifier the
    /// cloud-side handler maps to a server action; each `title` is what
    /// the OS shows.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub actions: Vec<PushAction>,
    /// Optional category for OS notification grouping.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    pub model: String,
    pub usage: UsageHint,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PushAction {
    pub id: String,
    pub title: String,
}

// ── Prompt template ────────────────────────────────────────────────────────

pub fn build_prompt(req: &ComposePushRequest) -> String {
    let language_label = match req.language.as_str() {
        "es" => "Spanish",
        _ => "English",
    };
    let platform_guidance = match req.platform.as_str() {
        "android" => "Android lockscreens show ~80 chars of body — fit the urgency in the first line.",
        "web" => "Web Push allows longer bodies; you may use the full 200-char budget.",
        _ => "iOS lockscreens show ~60 chars of body — fit the urgency in the first line.",
    };
    let actions_clause = if req.suggest_actions {
        format!(
            "Include 1-{MAX_ACTIONS} quick actions in `actions`. Suggested ids: \"ack\" (Acknowledge), \"open\" (Open alert), \"silence\" (Silence 1h)."
        )
    } else {
        "Set actions to an empty array.".into()
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

    let categories_csv = ALLOWED_CATEGORIES.join(", ");

    format!(
        r#"You are an incident notifier composing a mobile push notification.

Language: {language_label}.
Platform: {platform}. {platform_guidance}

Alert title: {alert_title}
Severity: {severity}
Source: {source}
Detail: {message}
Link: {url}

Hard limits:
- title: {MAX_TITLE_CHARS} chars max
- body: {MAX_BODY_CHARS} chars max
- actions: 0 to {MAX_ACTIONS}; each `id` is a short slug (a-z, 0-9, _, -)

{actions_clause}

Pick a category from this set (or leave null): {categories_csv}.

Respond with strict JSON, exactly this shape and no commentary or markdown fences:
{{"title": "<short urgent title>", "body": "<one-or-two-line body>", "actions": [{{"id": "<slug>", "title": "<UI label>"}}], "category": "<one of the allowed values, or null>"}}
"#,
        platform = req.platform,
    )
}

// ── Response parser ────────────────────────────────────────────────────────

pub fn parse_response(raw: &str) -> Result<ComposePushResponse, ComposeError> {
    let json_text = super::extract_json_object(raw)
        .ok_or_else(|| ComposeError::Malformed(super::truncate_for_log(raw)))?;
    let v: serde_json::Value = serde_json::from_str(&json_text).map_err(|e| {
        ComposeError::Malformed(format!("{}: {}", e, super::truncate_for_log(&json_text)))
    })?;

    let title_raw = v
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let body_raw = v
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if title_raw.is_empty() && body_raw.is_empty() {
        return Err(ComposeError::Malformed(super::truncate_for_log(raw)));
    }

    let title = clip_chars(&title_raw, MAX_TITLE_CHARS);
    let body = clip_chars(&body_raw, MAX_BODY_CHARS);

    let actions = match v.get("actions") {
        Some(serde_json::Value::Array(arr)) => parse_actions(arr)?,
        _ => Vec::new(),
    };

    let category = v.get("category").and_then(|v| v.as_str()).and_then(|s| {
        if ALLOWED_CATEGORIES.contains(&s) {
            Some(s.to_string())
        } else {
            // Drop unrecognized categories silently — cloud picks default.
            None
        }
    });

    Ok(ComposePushResponse {
        title,
        body,
        actions,
        category,
        model: String::new(),
        usage: UsageHint::default(),
    })
}

fn parse_actions(arr: &[serde_json::Value]) -> Result<Vec<PushAction>, ComposeError> {
    let mut out = Vec::new();
    for v in arr.iter().take(MAX_ACTIONS) {
        let obj = v.as_object().ok_or_else(|| {
            ComposeError::Malformed(format!("action not an object: {v}"))
        })?;
        let id = obj
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ComposeError::Malformed(format!("action missing id: {v}")))?
            .to_string();
        if !is_valid_action_id(&id) {
            return Err(ComposeError::Malformed(format!(
                "invalid action id '{id}' — must match [a-z0-9_-]+"
            )));
        }
        let title = obj
            .get("title")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ComposeError::Malformed(format!("action missing title: {v}")))?
            .to_string();
        if title.chars().count() > MAX_TITLE_CHARS {
            return Err(ComposeError::Malformed(format!(
                "action title exceeds {MAX_TITLE_CHARS} chars",
            )));
        }
        out.push(PushAction { id, title });
    }
    Ok(out)
}

fn is_valid_action_id(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// Clip on Unicode boundary; appends ellipsis if anything was trimmed.
pub fn clip_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out = String::with_capacity(max + 4);
    for (i, c) in text.chars().enumerate() {
        if i >= max {
            break;
        }
        out.push(c);
    }
    out.push('…');
    out
}

// ── Local AI invocation ────────────────────────────────────────────────────

pub async fn compose_push(
    local_ai: &Arc<LocalAI>,
    request: ComposePushRequest,
) -> Result<ComposePushResponse, ComposeError> {
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

    fn sample_request() -> ComposePushRequest {
        ComposePushRequest {
            alert: AlertContext {
                title: "Stripe webhook 503".into(),
                severity: "critical".into(),
                source: "vercel".into(),
                message: Some("Function timeout after 10s on /api/webhooks/stripe".into()),
                url: Some("https://app.inariwatch.com/alerts/abc".into()),
            },
            platform: "ios".into(),
            language: "en".into(),
            suggest_actions: true,
            model: None,
        }
    }

    #[test]
    fn build_prompt_includes_constraints() {
        let prompt = build_prompt(&sample_request());
        assert!(prompt.contains("Stripe webhook 503"));
        assert!(prompt.contains(&format!("title: {MAX_TITLE_CHARS} chars max")));
        assert!(prompt.contains(&format!("body: {MAX_BODY_CHARS} chars max")));
        assert!(prompt.contains("alert.critical"));
        assert!(prompt.contains("ack"));
    }

    #[test]
    fn build_prompt_respects_actions_toggle() {
        let mut req = sample_request();
        req.suggest_actions = false;
        let prompt = build_prompt(&req);
        assert!(prompt.contains("Set actions to an empty array"));
    }

    #[test]
    fn parse_response_handles_pure_json() {
        let raw = r#"{"title":"Stripe down","body":"Stripe webhook returning 503","actions":[{"id":"ack","title":"Acknowledge"}],"category":"alert.critical"}"#;
        let parsed = parse_response(raw).unwrap();
        assert_eq!(parsed.title, "Stripe down");
        assert_eq!(parsed.body, "Stripe webhook returning 503");
        assert_eq!(parsed.actions.len(), 1);
        assert_eq!(parsed.actions[0].id, "ack");
        assert_eq!(parsed.category.as_deref(), Some("alert.critical"));
    }

    #[test]
    fn parse_response_clips_title_and_body() {
        let big_title = "a".repeat(MAX_TITLE_CHARS + 10);
        let big_body = "b".repeat(MAX_BODY_CHARS + 50);
        let raw = format!(
            r#"{{"title":"{}","body":"{}","actions":[]}}"#,
            big_title, big_body
        );
        let parsed = parse_response(&raw).unwrap();
        assert_eq!(parsed.title.chars().count(), MAX_TITLE_CHARS + 1); // ellipsis
        assert_eq!(parsed.body.chars().count(), MAX_BODY_CHARS + 1);
        assert!(parsed.title.ends_with('…'));
        assert!(parsed.body.ends_with('…'));
    }

    #[test]
    fn parse_response_caps_actions_at_max() {
        let raw = r#"{"title":"t","body":"b","actions":[{"id":"a","title":"A"},{"id":"b","title":"B"},{"id":"c","title":"C"},{"id":"d","title":"D"},{"id":"e","title":"E"}]}"#;
        let parsed = parse_response(raw).unwrap();
        assert_eq!(parsed.actions.len(), MAX_ACTIONS);
    }

    #[test]
    fn parse_response_drops_unknown_category() {
        let raw = r#"{"title":"t","body":"b","actions":[],"category":"random.bogus"}"#;
        let parsed = parse_response(raw).unwrap();
        assert!(parsed.category.is_none());
    }

    #[test]
    fn parse_response_keeps_known_category() {
        let raw = r#"{"title":"t","body":"b","actions":[],"category":"deploy.failed"}"#;
        let parsed = parse_response(raw).unwrap();
        assert_eq!(parsed.category.as_deref(), Some("deploy.failed"));
    }

    #[test]
    fn parse_response_rejects_invalid_action_id() {
        let raw = r#"{"title":"t","body":"b","actions":[{"id":"BadId!","title":"X"}]}"#;
        let err = parse_response(raw).unwrap_err();
        assert!(matches!(err, ComposeError::Malformed(_)));
    }

    #[test]
    fn parse_response_rejects_action_without_title() {
        let raw = r#"{"title":"t","body":"b","actions":[{"id":"ack"}]}"#;
        let err = parse_response(raw).unwrap_err();
        assert!(matches!(err, ComposeError::Malformed(_)));
    }

    #[test]
    fn parse_response_rejects_completely_empty() {
        let raw = r#"{"title":"","body":""}"#;
        let err = parse_response(raw).unwrap_err();
        assert!(matches!(err, ComposeError::Malformed(_)));
    }

    #[test]
    fn parse_response_strips_code_fences() {
        let raw = r#"```json
{"title":"X","body":"Y","actions":[]}
```"#;
        let parsed = parse_response(raw).unwrap();
        assert_eq!(parsed.title, "X");
        assert_eq!(parsed.body, "Y");
    }

    #[test]
    fn is_valid_action_id_rejects_uppercase() {
        assert!(is_valid_action_id("ack_123"));
        assert!(is_valid_action_id("open-alert"));
        assert!(!is_valid_action_id("AckButton"));
        assert!(!is_valid_action_id(""));
        assert!(!is_valid_action_id("a b"));
    }

    #[test]
    fn clip_chars_handles_unicode() {
        let long = format!("{}🎉", "a".repeat(199));
        let clipped = clip_chars(&long, MAX_BODY_CHARS);
        // 199 + emoji = 200 chars, which equals MAX_BODY_CHARS — no clip.
        assert_eq!(clipped, long);
        let longer = format!("{}🎉extra", "a".repeat(199));
        let clipped2 = clip_chars(&longer, MAX_BODY_CHARS);
        assert_eq!(clipped2.chars().count(), MAX_BODY_CHARS + 1);
        assert!(clipped2.ends_with('…'));
    }
}
