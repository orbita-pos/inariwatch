//! v0.3 S3 — `notify.compose.email` handler (first local task).
//!
//! Per `INARI_AI_ARCHITECTURE.md` §1 (LOCKED 2026-05-02): "cómo decirlo"
//! tasks (notification composition) run on the user's local model. This
//! module is the desktop-side handler the relay invokes when the
//! workspace flag `localNotifyEnabled` is on AND the cloud router decides
//! `notify.compose.email` should land on user-sidecar.
//!
//! ## Pipeline
//!
//! 1. Relay forwards `dispatch` frame → `relay_client::handle_dispatch`
//!    matches on `task == "notify.compose.email"` and calls
//!    [`compose_email`].
//! 2. [`build_prompt`] turns the structured `ComposeEmailRequest` into a
//!    plain-text prompt — same template the cloud-side `notify.compose.email`
//!    rule will use, so eval scores are comparable across substrates.
//! 3. [`compose_email`] streams tokens from `crate::local_ai::LocalAI`
//!    (Qwen2.5-Coder-1.5B today; the registry catalogue grows in S4).
//! 4. [`parse_response`] extracts the strict JSON the prompt asks for.
//!    Models often fence with ``` ```json``` or prepend prose; we walk
//!    the brace-balanced first object, not a regex.
//! 5. [`build_signed_receipt`] signs `SHA-256(receipt_id)` with the local
//!    Ed25519 key per the S28 chain protocol (`lib_eap_verify::signed_digest`).
//!    Web persists this AS-IS via the user-sidecar receipt slot — the user's
//!    key is the source of truth for substrate=user-sidecar dispatches.
//!
//! ## What this module does NOT do
//!
//! - It does not own the WS state machine — `relay_client.rs` does.
//! - It does not pick the model — the request payload may set
//!   `payload.model`; we fall back to the v0.3 default
//!   ([`DEFAULT_MODEL_ID`]).
//! - It does not implement keychain key storage — S3 uses an env-var
//!   seed (`INARI_LIVE_RECEIPT_KEY_HEX`) with a deterministic dev-mode
//!   fallback. A future session swaps that for the OS keychain.

use std::sync::Arc;
use std::time::SystemTime;

use ed25519_dalek::{Signer, SigningKey};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::lib_eap_verify::{signed_digest, EAP_FORMAT_VERSION};
use crate::local_ai::{GenerateOptions, LocalAI, LocalAiError};

/// Default model id for `notify.compose.email`. The 1.5B Qwen-Coder-Instruct
/// is in the v0.2 catalogue and instruction-follows JSON output well at low
/// temperature. S4 may add Llama-3.2-3B-Instruct alongside it once the
/// rubric data points to a non-Coder variant being preferred.
pub const DEFAULT_MODEL_ID: &str = "qwen2.5-coder-1.5b";

/// Cap on tokens the model is allowed to generate. ~2-3 short paragraphs
/// of email body + a tiny JSON wrapper. Heavier limits invite hallucinated
/// suggested_actions.
pub const MAX_TOKENS: u32 = 512;

/// Sampling temperature for notify.compose.email. Low — we want stable,
/// instruction-following JSON, not creative prose. Aligns with the cloud
/// counterpart's recommendation in `web/lib/ai/prompts.ts`.
pub const TEMPERATURE: f32 = 0.3;

// ── Request / Response shape ───────────────────────────────────────────────

/// Inputs the relay forwards. Mirrors what `web/lib/ai-router/.../buildRelayPayload`
/// puts on the wire for `notify.compose.email`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ComposeEmailRequest {
    pub alert: AlertContext,
    #[serde(default = "default_recipient_role")]
    pub recipient_role: String,
    #[serde(default = "default_tone")]
    pub tone: String,
    #[serde(default = "default_language")]
    pub language: String,
    /// Optional explicit model override. Falls back to [`DEFAULT_MODEL_ID`].
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

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AlertContext {
    pub title: String,
    #[serde(default)]
    pub severity: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

/// Output the relay carries back as the dispatch `body`. Web's user-sidecar
/// provider drops this into `AIResponse.text` after JSON-serialising the
/// composition (so the caller — `web/lib/notifications/email.ts` — can parse
/// the same shape regardless of substrate).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComposeEmailResponse {
    pub subject: String,
    pub body: String,
    pub suggested_actions: Vec<String>,
    pub model: String,
    pub usage: UsageHint,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UsageHint {
    pub input_tokens: u32,
    pub output_tokens: u32,
}

#[derive(Debug, Error)]
pub enum ComposeError {
    #[error("local_ai: {0}")]
    LocalAi(#[from] LocalAiError),
    #[error("model returned malformed output (no JSON object): {0}")]
    Malformed(String),
}

// ── Prompt template ────────────────────────────────────────────────────────

/// Build the prompt the local model sees. Same structure as the cloud-side
/// counterpart in `web/lib/ai/prompts.ts:notifyComposeEmail` — keeping the
/// templates aligned is what lets the eval harness compare scores cross-
/// substrate without confounding the model with prompt drift.
pub fn build_prompt(req: &ComposeEmailRequest) -> String {
    let language_label = match req.language.as_str() {
        "es" => "Spanish",
        _ => "English",
    };
    let tone_guidance = match req.tone.as_str() {
        "detailed" => "include a one-paragraph context section and 2-3 recommended next steps",
        _ => "be concise — 2 short sentences max",
    };
    let role_guidance = match req.recipient_role.as_str() {
        "manager" => "Frame impact in business terms; avoid stack traces and code-level detail.",
        "stakeholder" => "Plain language; explain what users see, no internal jargon.",
        _ => "Technical detail OK; reference stack-trace fragments when useful.",
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
        r#"You are an incident notifier. Compose an email body for the following alert.

Language: {language_label}.
Tone: {tone_guidance}.
Recipient role: {recipient_role}. {role_guidance}

Alert title: {alert_title}
Severity: {severity}
Source: {source}
Detail: {message}
Link: {url}

Respond with strict JSON, exactly this shape and no commentary or markdown fences:
{{"subject": "<one line subject, <=80 chars>", "body": "<email body, plain text>", "suggested_actions": ["<short action>", "<short action>"]}}
"#,
        recipient_role = req.recipient_role,
    )
}

// ── Response parser ────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedJson {
    subject: String,
    body: String,
    suggested_actions: Vec<String>,
}

/// Extract the first balanced `{...}` object from raw model output, then
/// parse it as the email-composition JSON. Fences (` ```json ... ``` `),
/// prefixed prose ("Here's the email:"), and trailing commentary are all
/// tolerated as long as the first balanced object is well-formed.
pub fn parse_response(raw: &str) -> Result<ComposeEmailResponse, ComposeError> {
    let json_text = extract_json_object(raw)
        .ok_or_else(|| ComposeError::Malformed(truncate_for_log(raw)))?;
    let v: Value = serde_json::from_str(&json_text)
        .map_err(|e| ComposeError::Malformed(format!("{}: {}", e, truncate_for_log(&json_text))))?;
    let parsed = ParsedJson {
        subject: v
            .get("subject")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        body: v
            .get("body")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        suggested_actions: v
            .get("suggested_actions")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
    };
    if parsed.subject.is_empty() && parsed.body.is_empty() {
        return Err(ComposeError::Malformed(truncate_for_log(raw)));
    }
    Ok(ComposeEmailResponse {
        subject: parsed.subject,
        body: parsed.body,
        suggested_actions: parsed.suggested_actions,
        model: String::new(), // caller fills with the model id used
        usage: UsageHint::default(),
    })
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

fn truncate_for_log(s: &str) -> String {
    if s.len() <= 200 {
        s.to_string()
    } else {
        format!("{}…[+{} chars]", &s[..200], s.len() - 200)
    }
}

// ── Local AI invocation ────────────────────────────────────────────────────

/// Compose an email by streaming tokens from the local AI runtime. Caller
/// is responsible for wrapping the response in the relay frame and signing
/// the receipt — see [`build_signed_receipt`].
pub async fn compose_email(
    local_ai: &Arc<LocalAI>,
    request: ComposeEmailRequest,
) -> Result<ComposeEmailResponse, ComposeError> {
    let model_id = request
        .model
        .clone()
        .unwrap_or_else(|| DEFAULT_MODEL_ID.to_string());
    let prompt = build_prompt(&request);
    // chars/4 heuristic — same approach as `crate::ai::openai` for budget
    // tracking. cloud counterparts will surface real prompt_tokens.
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

// ── Receipt signing ────────────────────────────────────────────────────────

/// 32-byte seed source. Production loads `INARI_LIVE_RECEIPT_KEY_HEX`
/// (64 hex chars) from the keychain wrapper; dev/tests fall back to a
/// stable, well-documented zero-nonce seed so signatures are reproducible
/// without provisioning crypto material. A future session swaps the env-
/// var path for an OS-keychain entry.
fn load_signing_key() -> SigningKey {
    if let Ok(hex) = std::env::var("INARI_LIVE_RECEIPT_KEY_HEX") {
        if let Some(bytes) = decode_hex_32(&hex) {
            return SigningKey::from_bytes(&bytes);
        }
    }
    // Dev fallback. Replace with keychain lookup in S4+.
    let mut seed = [0u8; 32];
    seed[0] = 0xDE;
    seed[1] = 0xAD;
    seed[2] = 0xBE;
    seed[3] = 0xEF;
    seed[31] = 0x01;
    SigningKey::from_bytes(&seed)
}

fn decode_hex_32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        let pair = &s[i * 2..i * 2 + 2];
        out[i] = u8::from_str_radix(pair, 16).ok()?;
    }
    Some(out)
}

fn ed25519_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// Compute the receipt id (SHA-256 of the canonical body). Format matches
/// `lib_eap_verify::EapReceipt::receipt_id` — 64 hex chars, lowercase.
fn compute_receipt_id(canonical_body: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(canonical_body);
    let digest = hasher.finalize();
    ed25519_hex(&digest[..])
}

/// Build a signed Ed25519 receipt for a notify.compose.email run. Output
/// shape matches `lib_eap_verify::EapReceipt` so the existing `inari-verify`
/// CLI + the web `/api/eap/verify/[receiptId]` endpoint can validate it
/// without changes. Web's user-sidecar provider stores this raw in the
/// `user_sidecar_receipt` JSONB column (no re-signing).
pub fn build_signed_receipt(
    request_id: &str,
    task: &str,
    model: &str,
    response: &ComposeEmailResponse,
) -> serde_json::Value {
    let signer = load_signing_key();
    let public_key = signer.verifying_key();

    let ts_ms = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    // Canonical body fed into the SHA-256 that becomes receipt_id. Every
    // semantic field of the dispatch is included — the response_hash is a
    // BLAKE3 of the JSON body so a tampered body invalidates the receipt
    // even though the signature only commits to receipt_id.
    let response_json = serde_json::to_vec(response).unwrap_or_default();
    let response_hash = blake3::hash(&response_json).to_hex().to_string();
    let canonical = serde_json::json!({
        "request_id": request_id,
        "task": task,
        "model": model,
        "ts_ms": ts_ms,
        "response_hash": response_hash,
    });
    let canonical_bytes = serde_json::to_vec(&canonical).unwrap_or_default();
    let receipt_id = compute_receipt_id(&canonical_bytes);

    // Sign the digest the S28 verifier expects: SHA-256(receipt_id).
    let digest = signed_digest(&receipt_id);
    let signature = signer.sign(&digest);

    // EapReceipt::timestamp is a string field — store the millis as a
    // string so the existing verifier (`lib_eap_verify::parse_receipt_str`)
    // accepts the receipt without schema gymnastics. ts_ms is also kept as
    // a number for analytics consumers that prefer it numeric.
    serde_json::json!({
        "version": EAP_FORMAT_VERSION,
        "receipt_id": receipt_id,
        "merkle_root": receipt_id,
        "signed": true,
        "signature": ed25519_hex(&signature.to_bytes()),
        "public_key": ed25519_hex(public_key.as_bytes()),
        "attestor": "inari-live-sidecar",
        "model": model,
        "timestamp": ts_ms.to_string(),
        "ts_ms": ts_ms,
        "response_hash": response_hash,
        "task": task,
        "request_id": request_id,
    })
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests;
