//! v0.3 S5 — `notify.compose.whatsapp` handler.
//!
//! Mirrors `notify_compose::compose_email` but produces WhatsApp-shaped
//! output: short plain-text body capped at 1024 chars (Meta's text-body
//! ceiling), no markdown (WhatsApp's Bold/Italic syntax is asterisk-
//! based and inconsistent across renderers, so we strip it from the
//! local-model prompt up front), optional inline reply buttons.
//!
//! Same privacy invariant as email: when the workspace flag
//! `localNotifyEnabled` is on, the alert text the user receives on
//! WhatsApp is composed entirely on their machine. The transport
//! (web's `web/lib/whatsapp/client.ts`) only sees the final body.
//!
//! ## Pipeline
//!
//! 1. Relay → `relay_client::handle_dispatch` matches
//!    `task == "notify.compose.whatsapp"`, calls [`compose_whatsapp`].
//! 2. [`build_prompt`] turns the structured request into plain-text
//!    instructions that pin the 1024-char ceiling, no-markdown, no-link-
//!    preview rules.
//! 3. [`compose_whatsapp`] streams tokens from `crate::local_ai::LocalAI`.
//! 4. [`parse_response`] extracts the strict JSON the prompt requested
//!    (same brace-balanced parser used for email).
//! 5. The handler in `relay_client.rs` signs a receipt via
//!    `notify_compose::build_signed_receipt` (shared with email — the
//!    EAP receipt schema is task-agnostic).
//!
//! ## What the model is NOT allowed to emit
//! - Markdown fences / `**bold**` / `_italic_` syntax
//! - URLs in the body (we render them in a separate `link` field)
//! - More than 3 inline buttons (Meta's interactive-message cap)

use std::sync::Arc;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::local_ai::{GenerateOptions, LocalAI};
use crate::notify_compose::{ComposeError, UsageHint};

use super::{AlertContext, DEFAULT_MODEL_ID, MAX_TOKENS, TEMPERATURE};

/// WhatsApp text-body ceiling per Meta Cloud API. Mirrored in the web-
/// side validator (`web/lib/whatsapp/types.ts:WHATSAPP_MAX_BODY_CHARS`).
pub const MAX_BODY_CHARS: usize = 1024;

/// Inputs the relay forwards. Roughly the same shape as
/// `ComposeEmailRequest` minus the `tone` knob (WhatsApp is always
/// concise) plus an optional `recipient_phone` for receipts.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ComposeWhatsAppRequest {
    pub alert: AlertContext,
    /// Recipient phone in E.164 (no leading +). Optional — if absent,
    /// the cloud transport reads it from the workspace's WhatsApp
    /// channel config.
    #[serde(default)]
    pub recipient_phone: Option<String>,
    /// "developer" | "manager" | "stakeholder". Same labels as email.
    #[serde(default = "default_recipient_role")]
    pub recipient_role: String,
    /// "en" | "es" — only two supported in v0.3 (matches voice).
    #[serde(default = "default_language")]
    pub language: String,
    /// Optional model override; falls back to [`DEFAULT_MODEL_ID`].
    #[serde(default)]
    pub model: Option<String>,
}

fn default_recipient_role() -> String {
    "developer".into()
}
fn default_language() -> String {
    "en".into()
}

/// Inline reply button — same shape as `web/lib/whatsapp/types.ts`. The
/// local model is constrained to ≤ 3 buttons by the prompt; we
/// double-check here so a misbehaving model can't blow past the cap.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhatsAppButton {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComposeWhatsAppResponse {
    pub body: String,
    /// ≤ 3 buttons. Empty when the alert doesn't warrant a quick action.
    #[serde(default)]
    pub buttons: Vec<WhatsAppButton>,
    pub model: String,
    pub usage: UsageHint,
}

// ── Prompt template ────────────────────────────────────────────────────────

/// Build the prompt the local model sees. WhatsApp messages are short,
/// punchy, and stripped of any markdown that would render as literal
/// asterisks in WhatsApp clients. Keep this template aligned with the
/// cloud-side counterpart in `web/lib/ai/prompts.ts:notifyComposeWhatsapp`
/// (added when the cloud fallback path lands) — eval scores depend on
/// equivalent prompts.
pub fn build_prompt(req: &ComposeWhatsAppRequest) -> String {
    let language_label = match req.language.as_str() {
        "es" => "Spanish",
        _ => "English",
    };
    let role_guidance = match req.recipient_role.as_str() {
        "manager" => "Frame the impact in business terms — no stack traces, no code references.",
        "stakeholder" => "Plain language only. Explain what users see, no internal jargon.",
        _ => "Technical detail OK in 1-2 short sentences. Stack-trace fragments OK if material.",
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

    format!(
        r#"You are an incident notifier. Compose a WhatsApp message body for the following alert.

Hard rules:
- Plain text ONLY. No markdown, no asterisks, no underscores, no backticks.
- Max 1024 characters in the body. Most alerts should fit in 200-400.
- No URLs in the body. The cloud-side dispatcher attaches a link separately.
- 0-3 short reply buttons (each ≤ 20 chars). Leave the array empty when no action is obvious.

Language: {language_label}.
Recipient role: {recipient_role}. {role_guidance}

Alert title: {alert_title}
Severity: {severity}
Source: {source}
Detail: {message}

Respond with strict JSON, exactly this shape and no commentary or markdown fences:
{{"body": "<plain text body, ≤1024 chars>", "buttons": [{{"id": "ack", "title": "Acknowledge"}}]}}
"#,
        recipient_role = req.recipient_role,
    )
}

// ── Response parser ────────────────────────────────────────────────────────

/// Parse the model's JSON output. Reuses the brace-balanced extractor
/// from `notify_compose::extract_json_object` via `super::parse_response`-
/// style logic — duplicated rather than re-imported because email's
/// parser sits behind a stricter shape (subject required) that doesn't
/// fit WhatsApp.
pub fn parse_response(raw: &str) -> Result<ComposeWhatsAppResponse, ComposeError> {
    let json_text = extract_json_object(raw)
        .ok_or_else(|| ComposeError::Malformed(truncate(raw)))?;
    let v: Value = serde_json::from_str(&json_text)
        .map_err(|e| ComposeError::Malformed(format!("{}: {}", e, truncate(&json_text))))?;
    let body = v
        .get("body")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let mut buttons: Vec<WhatsAppButton> = v
        .get("buttons")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|entry| {
                    let id = entry.get("id").and_then(|x| x.as_str())?;
                    let title = entry.get("title").and_then(|x| x.as_str())?;
                    Some(WhatsAppButton {
                        id: id.to_string(),
                        title: title.chars().take(20).collect(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    if buttons.len() > 3 {
        buttons.truncate(3);
    }
    if body.is_empty() {
        return Err(ComposeError::Malformed(truncate(raw)));
    }
    let cleaned = sanitize_body(&body);
    Ok(ComposeWhatsAppResponse {
        body: cleaned,
        buttons,
        model: String::new(), // caller fills with the model id used
        usage: UsageHint::default(),
    })
}

/// Strip markdown that would render literally in WhatsApp clients,
/// then enforce the 1024-char cap. Preserves emojis (most WA clients
/// render them natively) and line breaks.
fn sanitize_body(input: &str) -> String {
    // Drop fenced code blocks first so triple-backtick fences don't
    // leave dangling backticks we'd then strip individually.
    let mut s = strip_fenced_blocks(input);
    // Strip the simplest markdown markers — these are the ones the
    // model emits most often. WhatsApp's own *bold*/_italic_/~strike~
    // are technically supported but inconsistent across clients, so
    // we drop them all.
    for ch in ['*', '_', '`', '~'] {
        s = s.replace(ch, "");
    }
    // Collapse Windows line endings → Unix; trim trailing whitespace
    // per line to avoid the "extra ▒ char" some clients render for
    // trailing CRs.
    let collapsed: String = s.replace("\r\n", "\n");
    let trimmed: String = collapsed
        .lines()
        .map(|l| l.trim_end())
        .collect::<Vec<_>>()
        .join("\n");
    // Hard cap.
    if trimmed.chars().count() > MAX_BODY_CHARS {
        trimmed.chars().take(MAX_BODY_CHARS).collect()
    } else {
        trimmed
    }
}

fn strip_fenced_blocks(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut depth = 0u8;
    for line in input.lines() {
        if line.trim_start().starts_with("```") {
            depth = if depth == 0 { 1 } else { 0 };
            continue;
        }
        if depth == 0 {
            out.push_str(line);
            out.push('\n');
        }
    }
    if out.ends_with('\n') {
        out.pop();
    }
    out
}

fn extract_json_object(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let start = raw.find('{')?;
    let mut depth = 0u32;
    let mut in_string = false;
    let mut escape = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if escape {
            escape = false;
            continue;
        }
        if in_string {
            match b {
                b'"' => in_string = false,
                b'\\' => escape = true,
                _ => {}
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(raw[start..=i].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

fn truncate(s: &str) -> String {
    if s.len() <= 200 {
        s.to_string()
    } else {
        format!("{}…[+{} chars]", &s[..200], s.len() - 200)
    }
}

// ── Local AI invocation ────────────────────────────────────────────────────

pub async fn compose_whatsapp(
    local_ai: &Arc<LocalAI>,
    request: ComposeWhatsAppRequest,
) -> Result<ComposeWhatsAppResponse, ComposeError> {
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

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notify_compose::AlertContext;

    fn req() -> ComposeWhatsAppRequest {
        ComposeWhatsAppRequest {
            alert: AlertContext {
                title: "Stripe webhook returned 503".to_string(),
                severity: "critical".to_string(),
                source: "vercel".to_string(),
                message: Some("Function timeout after 10s".to_string()),
                url: None,
            },
            recipient_phone: Some("15551234567".to_string()),
            recipient_role: "developer".to_string(),
            language: "en".to_string(),
            model: None,
        }
    }

    #[test]
    fn build_prompt_pins_1024_cap_and_no_markdown_rule() {
        let p = build_prompt(&req());
        assert!(p.contains("Plain text ONLY"));
        assert!(p.contains("Max 1024 characters"));
        assert!(p.contains("≤ 20 chars"));
        assert!(p.contains("Stripe webhook returned 503"));
    }

    #[test]
    fn build_prompt_switches_role_guidance() {
        let mut r = req();
        r.recipient_role = "manager".to_string();
        let p = build_prompt(&r);
        assert!(p.contains("business terms"));
        assert!(!p.contains("Stack-trace fragments"));
    }

    #[test]
    fn parse_response_extracts_body_and_buttons() {
        let raw = r#"
        Here's the message:
        {"body": "Stripe webhook is down. Customers cannot complete checkout.",
         "buttons": [{"id": "ack", "title": "Acknowledge"},
                     {"id": "rb", "title": "Rollback"}]}
        "#;
        let r = parse_response(raw).expect("parse ok");
        assert!(r.body.contains("Stripe"));
        assert_eq!(r.buttons.len(), 2);
        assert_eq!(r.buttons[0].id, "ack");
    }

    #[test]
    fn parse_response_caps_buttons_at_three() {
        let raw = r#"{"body": "x", "buttons": [
            {"id":"1","title":"A"},
            {"id":"2","title":"B"},
            {"id":"3","title":"C"},
            {"id":"4","title":"D"}
        ]}"#;
        let r = parse_response(raw).expect("parse ok");
        assert_eq!(r.buttons.len(), 3);
    }

    #[test]
    fn parse_response_truncates_button_titles_to_20() {
        let raw = r#"{"body":"x","buttons":[{"id":"1","title":"This is way too long for WhatsApp"}]}"#;
        let r = parse_response(raw).expect("parse ok");
        assert!(r.buttons[0].title.chars().count() <= 20);
    }

    #[test]
    fn parse_response_strips_markdown_from_body() {
        let raw = r#"{"body": "This is *important* and `urgent` ~now~", "buttons": []}"#;
        let r = parse_response(raw).expect("parse ok");
        assert!(!r.body.contains('*'));
        assert!(!r.body.contains('`'));
        assert!(!r.body.contains('~'));
        assert!(r.body.contains("important"));
    }

    #[test]
    fn parse_response_strips_fenced_code_blocks() {
        let raw = "```json\n{\"body\": \"hi\", \"buttons\": []}\n```";
        let r = parse_response(raw).expect("parse ok");
        assert_eq!(r.body, "hi");
    }

    #[test]
    fn sanitize_caps_at_1024_chars() {
        let huge = "a".repeat(MAX_BODY_CHARS + 200);
        let cleaned = sanitize_body(&huge);
        assert_eq!(cleaned.chars().count(), MAX_BODY_CHARS);
    }

    #[test]
    fn parse_response_rejects_empty_body() {
        let raw = r#"{"body":"","buttons":[]}"#;
        let res = parse_response(raw);
        assert!(matches!(res, Err(ComposeError::Malformed(_))));
    }

    #[test]
    fn parse_response_rejects_completely_malformed() {
        let res = parse_response("hello world no JSON here");
        assert!(matches!(res, Err(ComposeError::Malformed(_))));
    }
}
