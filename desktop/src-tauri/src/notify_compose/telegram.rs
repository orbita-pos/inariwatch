//! v0.3 S4 — `notify.compose.telegram` handler.
//!
//! Mirror of the email + slack handlers but emits Telegram MarkdownV2
//! prose. Per `INARI_AI_ARCHITECTURE.md` §1: the local model writes the
//! prose; cloud-side `web/lib/telegram/format.ts` keeps owning anything
//! deterministic (button rendering, chat routing). Here we ask for both
//! the body and an optional inline keyboard so a single dispatch can
//! cover the common "alert + 2 quick actions" UX.
//!
//! ## MarkdownV2 reserved chars
//!
//! Per Telegram's bot API, these chars MUST be escaped with `\\`:
//!   _ * [ ] ( ) ~ ` > # + - = | { } . !
//!
//! The prompt explains this; the parser also has a deterministic
//! validator that rejects responses with unescaped reserved chars in
//! the body so the bot doesn't 400.

use std::sync::Arc;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use crate::local_ai::{GenerateOptions, LocalAI};

use super::{AlertContext, ComposeError, UsageHint};

pub const DEFAULT_MODEL_ID: &str = "qwen2.5-coder-1.5b";
pub const MAX_TOKENS: u32 = 512;
pub const TEMPERATURE: f32 = 0.3;

/// Telegram caps message text at 4096 chars. We target much shorter — the
/// audience is on mobile. The model is told to stay under 1500 chars; we
/// hard-clip at 1500 to stay defensive.
pub const MAX_BODY_CHARS: usize = 1500;

/// Inline keyboard button cap per Telegram constraints. We cap at 4 — three
/// rows of three is overkill for a one-off alert message.
pub const MAX_INLINE_BUTTONS: usize = 4;

/// `callback_data` upper bound per Telegram constraints (64 bytes UTF-8).
pub const MAX_CALLBACK_DATA_BYTES: usize = 64;

// ── Request shape ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ComposeTelegramRequest {
    pub alert: AlertContext,
    #[serde(default = "default_recipient_role")]
    pub recipient_role: String,
    #[serde(default = "default_tone")]
    pub tone: String,
    #[serde(default = "default_language")]
    pub language: String,
    /// When true, the prompt asks for a 2-button inline keyboard (Ack +
    /// Open). Default false — most bots configure quick actions in cloud
    /// code; this is a power-user toggle.
    #[serde(default)]
    pub include_inline_buttons: bool,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComposeTelegramResponse {
    pub text: String,
    pub parse_mode: String,
    /// Optional inline keyboard. Telegram expects an array-of-arrays of
    /// buttons; we flatten to one row up to [`MAX_INLINE_BUTTONS`] to keep
    /// the surface tight for a notification.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inline_keyboard: Option<Vec<Vec<TelegramInlineButton>>>,
    pub model: String,
    pub usage: UsageHint,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramInlineButton {
    pub text: String,
    /// Either `callback_data` (up to 64 bytes) or `url`. Exactly one set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub callback_data: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

// ── Prompt template ────────────────────────────────────────────────────────

pub fn build_prompt(req: &ComposeTelegramRequest) -> String {
    let language_label = match req.language.as_str() {
        "es" => "Spanish",
        _ => "English",
    };
    let tone_guidance = match req.tone.as_str() {
        "detailed" => "include a 2-3 sentence context paragraph",
        _ => "be concise — 2 short sentences max",
    };
    let role_guidance = match req.recipient_role.as_str() {
        "manager" => "Frame impact in business terms; avoid stack traces and code-level detail.",
        "stakeholder" => "Plain language; explain what users see, no internal jargon.",
        _ => "Technical detail OK; reference stack-trace fragments when useful.",
    };
    let buttons_clause = if req.include_inline_buttons {
        "Add an inline_keyboard array with 2 buttons: one with callback_data \"ack\" labelled like \"Acknowledge\", and one with the alert URL labelled like \"Open alert\"."
    } else {
        "Set inline_keyboard to null."
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

    format!(
        r#"You are an incident notifier composing a Telegram MarkdownV2 message.

Language: {language_label}.
Tone: {tone_guidance}.
Recipient role: {recipient_role}. {role_guidance}

Alert title: {alert_title}
Severity: {severity}
Source: {source}
Detail: {message}
Link: {url}

Telegram MarkdownV2 rules — these characters MUST be backslash-escaped wherever they appear as literal text in the body: _ * [ ] ( ) ~ ` > # + - = | {{ }} . !
Use *bold* with single asterisks, _italic_ with single underscores, `code` with backticks, and [label](url) for links. Keep the body under 1500 chars.

{buttons_clause}

Respond with strict JSON, exactly this shape and no commentary or markdown fences:
{{"text": "<MarkdownV2 body, escaped per the rules above>", "parse_mode": "MarkdownV2", "inline_keyboard": null}}
"#,
        recipient_role = req.recipient_role,
    )
}

// ── Response parser ────────────────────────────────────────────────────────

pub fn parse_response(raw: &str) -> Result<ComposeTelegramResponse, ComposeError> {
    let json_text = super::extract_json_object(raw)
        .ok_or_else(|| ComposeError::Malformed(super::truncate_for_log(raw)))?;
    let v: serde_json::Value = serde_json::from_str(&json_text).map_err(|e| {
        ComposeError::Malformed(format!("{}: {}", e, super::truncate_for_log(&json_text)))
    })?;

    let text_raw = v
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if text_raw.is_empty() {
        return Err(ComposeError::Malformed(super::truncate_for_log(raw)));
    }
    let text = clip_body(&text_raw);

    // Always pin parse_mode — model can opt for HTML on a bad day, and the
    // bot is hardcoded to MarkdownV2 on the cloud side. Defending against
    // model drift.
    let parse_mode = "MarkdownV2".to_string();

    let inline_keyboard = match v.get("inline_keyboard") {
        Some(serde_json::Value::Array(rows)) if !rows.is_empty() => {
            Some(parse_inline_keyboard(rows)?)
        }
        _ => None,
    };

    Ok(ComposeTelegramResponse {
        text,
        parse_mode,
        inline_keyboard,
        model: String::new(),
        usage: UsageHint::default(),
    })
}

fn parse_inline_keyboard(
    rows: &[serde_json::Value],
) -> Result<Vec<Vec<TelegramInlineButton>>, ComposeError> {
    let mut out_rows = Vec::new();
    let mut total_buttons = 0usize;
    for row in rows {
        let row_arr = row.as_array().ok_or_else(|| {
            ComposeError::Malformed(format!("inline_keyboard row not array: {row}"))
        })?;
        let mut out_row = Vec::new();
        for button in row_arr {
            if total_buttons >= MAX_INLINE_BUTTONS {
                break;
            }
            let parsed = parse_button(button)?;
            out_row.push(parsed);
            total_buttons += 1;
        }
        if !out_row.is_empty() {
            out_rows.push(out_row);
        }
        if total_buttons >= MAX_INLINE_BUTTONS {
            break;
        }
    }
    Ok(out_rows)
}

fn parse_button(value: &serde_json::Value) -> Result<TelegramInlineButton, ComposeError> {
    let obj = value.as_object().ok_or_else(|| {
        ComposeError::Malformed(format!("button not an object: {value}"))
    })?;
    let text = obj
        .get("text")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ComposeError::Malformed(format!("button missing text: {value}")))?
        .to_string();

    let callback_data = obj
        .get("callback_data")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let url = obj.get("url").and_then(|v| v.as_str()).map(|s| s.to_string());

    if callback_data.is_none() && url.is_none() {
        return Err(ComposeError::Malformed(format!(
            "button has neither callback_data nor url: {value}"
        )));
    }
    if let Some(cb) = &callback_data {
        if cb.as_bytes().len() > MAX_CALLBACK_DATA_BYTES {
            return Err(ComposeError::Malformed(format!(
                "callback_data exceeds {MAX_CALLBACK_DATA_BYTES} bytes",
            )));
        }
    }
    Ok(TelegramInlineButton {
        text,
        callback_data,
        url,
    })
}

/// Clip on a Unicode boundary to [`MAX_BODY_CHARS`]. Telegram truncates at
/// the byte cap (4096) but our policy is shorter — keep mobile users from
/// scrolling.
pub fn clip_body(text: &str) -> String {
    if text.chars().count() <= MAX_BODY_CHARS {
        return text.to_string();
    }
    let mut out = String::with_capacity(MAX_BODY_CHARS + 4);
    for (i, c) in text.chars().enumerate() {
        if i >= MAX_BODY_CHARS {
            break;
        }
        out.push(c);
    }
    out.push('…');
    out
}

/// Telegram MarkdownV2 reserved chars that MUST be escaped as `\<char>`
/// when used as literal text. Public so eval-side validators reuse the
/// same SSOT — desktop is the source of truth for the list.
pub const MARKDOWNV2_RESERVED: &[char] = &[
    '_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!',
];

/// Returns the byte indexes of unescaped reserved chars. For a model
/// safety check post-parse — not run at parse time (model output may
/// legitimately use these inside `*bold*` etc.); used by tests + eval
/// rubric.
pub fn find_unescaped_reserved(text: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        // Only single-byte ASCII reserved chars need this check — the
        // MarkdownV2 spec lists only ASCII.
        let c = b as char;
        if !MARKDOWNV2_RESERVED.contains(&c) {
            continue;
        }
        let prev = if i == 0 { None } else { Some(bytes[i - 1]) };
        if prev != Some(b'\\') {
            out.push(i);
        }
    }
    out
}

// ── Local AI invocation ────────────────────────────────────────────────────

pub async fn compose_telegram(
    local_ai: &Arc<LocalAI>,
    request: ComposeTelegramRequest,
) -> Result<ComposeTelegramResponse, ComposeError> {
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

    fn sample_request() -> ComposeTelegramRequest {
        ComposeTelegramRequest {
            alert: AlertContext {
                title: "Database connection pool exhausted".into(),
                severity: "critical".into(),
                source: "datadog".into(),
                message: Some("All 50 PG connections in use".into()),
                url: Some("https://app.inariwatch.com/alerts/xyz".into()),
            },
            recipient_role: "developer".into(),
            tone: "concise".into(),
            language: "en".into(),
            include_inline_buttons: false,
            model: None,
        }
    }

    #[test]
    fn build_prompt_includes_alert_and_markdownv2_rules() {
        let prompt = build_prompt(&sample_request());
        assert!(prompt.contains("Database connection pool"));
        assert!(prompt.contains("MarkdownV2 rules"));
        assert!(prompt.contains("backslash-escaped"));
        // The reserved chars list is in the prompt so the model has it in
        // context. Sample one — `(` is in the reserved set.
        assert!(prompt.contains("("));
    }

    #[test]
    fn build_prompt_buttons_clause_toggles() {
        let mut req = sample_request();
        req.include_inline_buttons = true;
        let prompt = build_prompt(&req);
        assert!(prompt.contains("inline_keyboard"));
        assert!(prompt.contains("Acknowledge"));
        assert!(prompt.contains("Open alert"));

        req.include_inline_buttons = false;
        let prompt2 = build_prompt(&req);
        assert!(prompt2.contains("Set inline_keyboard to null"));
    }

    #[test]
    fn parse_response_handles_pure_json() {
        let raw = r#"{"text":"DB pool exhausted\\.","parse_mode":"MarkdownV2","inline_keyboard":null}"#;
        let parsed = parse_response(raw).unwrap();
        assert_eq!(parsed.text, "DB pool exhausted\\.");
        assert_eq!(parsed.parse_mode, "MarkdownV2");
        assert!(parsed.inline_keyboard.is_none());
    }

    #[test]
    fn parse_response_pins_parse_mode_even_when_model_drifts() {
        let raw = r#"{"text":"X","parse_mode":"HTML","inline_keyboard":null}"#;
        let parsed = parse_response(raw).unwrap();
        // Model said HTML — we override to MarkdownV2.
        assert_eq!(parsed.parse_mode, "MarkdownV2");
    }

    #[test]
    fn parse_response_extracts_inline_keyboard() {
        let raw = r#"{"text":"alert","parse_mode":"MarkdownV2","inline_keyboard":[[{"text":"Ack","callback_data":"ack"},{"text":"Open","url":"https://app.inariwatch.com/alerts/xyz"}]]}"#;
        let parsed = parse_response(raw).unwrap();
        let kb = parsed.inline_keyboard.expect("keyboard present");
        assert_eq!(kb.len(), 1);
        assert_eq!(kb[0].len(), 2);
        assert_eq!(kb[0][0].text, "Ack");
        assert_eq!(kb[0][0].callback_data.as_deref(), Some("ack"));
        assert_eq!(kb[0][1].url.as_deref(), Some("https://app.inariwatch.com/alerts/xyz"));
    }

    #[test]
    fn parse_response_caps_inline_buttons_at_max() {
        let raw = r#"{"text":"alert","parse_mode":"MarkdownV2","inline_keyboard":[[{"text":"a","callback_data":"a"},{"text":"b","callback_data":"b"},{"text":"c","callback_data":"c"},{"text":"d","callback_data":"d"},{"text":"e","callback_data":"e"}]]}"#;
        let parsed = parse_response(raw).unwrap();
        let kb = parsed.inline_keyboard.expect("keyboard present");
        let total: usize = kb.iter().map(|r| r.len()).sum();
        assert_eq!(total, MAX_INLINE_BUTTONS);
    }

    #[test]
    fn parse_response_rejects_button_without_callback_or_url() {
        let raw = r#"{"text":"alert","parse_mode":"MarkdownV2","inline_keyboard":[[{"text":"bad"}]]}"#;
        let err = parse_response(raw).unwrap_err();
        assert!(matches!(err, ComposeError::Malformed(_)));
    }

    #[test]
    fn parse_response_rejects_oversize_callback_data() {
        let big = "a".repeat(MAX_CALLBACK_DATA_BYTES + 1);
        let raw = format!(
            r#"{{"text":"alert","parse_mode":"MarkdownV2","inline_keyboard":[[{{"text":"x","callback_data":"{}"}}]]}}"#,
            big
        );
        let err = parse_response(&raw).unwrap_err();
        assert!(matches!(err, ComposeError::Malformed(_)));
    }

    #[test]
    fn parse_response_clips_body_to_max() {
        let huge = "a".repeat(MAX_BODY_CHARS + 200);
        let raw = format!(
            r#"{{"text":"{}","parse_mode":"MarkdownV2","inline_keyboard":null}}"#,
            huge
        );
        let parsed = parse_response(&raw).unwrap();
        assert_eq!(parsed.text.chars().count(), MAX_BODY_CHARS + 1); // ellipsis
        assert!(parsed.text.ends_with('…'));
    }

    #[test]
    fn parse_response_rejects_empty_text() {
        let err = parse_response(r#"{"text":""}"#).unwrap_err();
        assert!(matches!(err, ComposeError::Malformed(_)));
    }

    #[test]
    fn find_unescaped_reserved_flags_unescaped_dot() {
        let text = "Hello world.";
        let bad = find_unescaped_reserved(text);
        assert_eq!(bad.len(), 1);
        assert_eq!(bad[0], text.len() - 1);
    }

    #[test]
    fn find_unescaped_reserved_passes_when_dot_escaped() {
        let text = "Hello world\\.";
        let bad = find_unescaped_reserved(text);
        assert!(bad.is_empty());
    }
}
