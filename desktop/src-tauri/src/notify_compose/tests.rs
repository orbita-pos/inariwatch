//! Pure-function unit tests for the v0.3 S3 notify.compose.email handler.
//!
//! `compose_email` itself spawns llama-server + streams tokens and isn't
//! safely runnable in CI. The pieces we CAN exercise without a model are:
//! the prompt builder, the JSON parser (the brittle bit when models
//! prepend prose / fence the JSON), and the receipt signer (verifiable
//! end-to-end via `lib_eap_verify::verify`).

use super::*;
use crate::lib_eap_verify::{parse_receipt_str, verify, VerifyOutcome};

fn sample_request() -> ComposeEmailRequest {
    ComposeEmailRequest {
        alert: AlertContext {
            title: "TypeError: Cannot read property 'id' of undefined".into(),
            severity: "critical".into(),
            source: "sentry".into(),
            message: Some("at handleSubmit (form.tsx:42:11)".into()),
            url: Some("https://app.inariwatch.com/alerts/abc".into()),
        },
        recipient_role: "developer".into(),
        tone: "concise".into(),
        language: "en".into(),
        model: None,
    }
}

#[test]
fn build_prompt_includes_alert_title_and_severity() {
    let prompt = build_prompt(&sample_request());
    assert!(prompt.contains("TypeError: Cannot read property"));
    assert!(prompt.contains("critical"));
    assert!(prompt.contains("sentry"));
    // The strict-JSON contract is critical — the parser depends on the
    // model emitting the exact JSON shape.
    assert!(prompt.contains(r#"{"subject":"#));
    assert!(prompt.contains("suggested_actions"));
}

#[test]
fn build_prompt_switches_language_for_es() {
    let mut req = sample_request();
    req.language = "es".into();
    let prompt = build_prompt(&req);
    assert!(prompt.contains("Spanish"));
    // No language=en leakage when es is requested — safety against the
    // template regressing to a hardcoded English label.
    assert!(!prompt.contains("Language: English"));
}

#[test]
fn build_prompt_role_guidance_changes_for_manager() {
    let mut req = sample_request();
    req.recipient_role = "manager".into();
    let prompt = build_prompt(&req);
    assert!(prompt.contains("business terms"));
    assert!(!prompt.contains("stack-trace fragments"));
}

#[test]
fn parse_response_handles_pure_json() {
    let raw = r#"{"subject":"Error in form","body":"Form submit broke","suggested_actions":["check git blame","rollback"]}"#;
    let parsed = parse_response(raw).unwrap();
    assert_eq!(parsed.subject, "Error in form");
    assert_eq!(parsed.body, "Form submit broke");
    assert_eq!(parsed.suggested_actions.len(), 2);
}

#[test]
fn parse_response_strips_code_fences_and_prefix_prose() {
    // Models routinely fence JSON output despite the prompt forbidding it.
    let raw = r#"Here's the email:
```json
{"subject":"X","body":"Y","suggested_actions":["a"]}
```
"#;
    let parsed = parse_response(raw).unwrap();
    assert_eq!(parsed.subject, "X");
    assert_eq!(parsed.body, "Y");
    assert_eq!(parsed.suggested_actions, vec!["a"]);
}

#[test]
fn parse_response_handles_nested_braces_in_body() {
    // body containing `{` shouldn't trip the brace counter.
    let raw = r#"{"subject":"S","body":"context: {\"k\":\"v\"}","suggested_actions":[]}"#;
    let parsed = parse_response(raw).unwrap();
    assert!(parsed.body.contains("context"));
    assert_eq!(parsed.suggested_actions.len(), 0);
}

#[test]
fn parse_response_rejects_no_json() {
    let err = parse_response("just prose, no JSON here").unwrap_err();
    matches!(err, ComposeError::Malformed(_));
}

#[test]
fn parse_response_rejects_object_with_only_unknown_keys() {
    // No `subject` nor `body` populated → parser flags malformed because
    // an empty composition is never useful (fallback to cloud is better).
    let err = parse_response(r#"{"foo":"bar"}"#).unwrap_err();
    matches!(err, ComposeError::Malformed(_));
}

#[test]
fn parse_response_tolerates_trailing_commentary() {
    let raw = r#"{"subject":"S","body":"B","suggested_actions":[]}

Hope that helps!"#;
    let parsed = parse_response(raw).unwrap();
    assert_eq!(parsed.subject, "S");
}

#[test]
fn signed_receipt_verifies_via_lib_eap_verify() {
    // End-to-end signing → verify round-trip. If this regresses, the
    // existing `inari-verify` CLI + web `/api/eap/verify/[receiptId]`
    // would also reject the receipt — same digest protocol.
    let response = ComposeEmailResponse {
        subject: "Test".into(),
        body: "Test body".into(),
        suggested_actions: vec!["look".into()],
        model: "qwen2.5-coder-1.5b".into(),
        usage: UsageHint::default(),
    };
    let receipt_json = build_signed_receipt(
        "req-abc",
        "notify.compose.email",
        "qwen2.5-coder-1.5b",
        &response,
    );
    let raw = serde_json::to_string(&receipt_json).unwrap();
    let parsed = parse_receipt_str(&raw).expect("parse");
    let outcome = verify(&parsed);
    assert!(
        matches!(outcome, VerifyOutcome::Signed { .. }),
        "expected Signed, got {:?}",
        outcome
    );
}

#[test]
fn signed_receipt_carries_request_id_and_response_hash() {
    let response = ComposeEmailResponse {
        subject: "S".into(),
        body: "B".into(),
        suggested_actions: vec![],
        model: "qwen2.5-coder-1.5b".into(),
        usage: UsageHint::default(),
    };
    let r1 = build_signed_receipt("req-1", "notify.compose.email", "m", &response);
    let r2 = build_signed_receipt("req-2", "notify.compose.email", "m", &response);
    // Different request ids → different receipt_ids (ts_ms differs and
    // request_id differs, so the canonical bytes diverge).
    assert_ne!(r1["receipt_id"], r2["receipt_id"]);
    // Both reference the same response → same response_hash.
    assert_eq!(r1["response_hash"], r2["response_hash"]);
}

#[test]
fn signed_receipt_changes_when_response_body_changes() {
    let a = ComposeEmailResponse {
        subject: "A".into(),
        body: "A body".into(),
        suggested_actions: vec![],
        model: "m".into(),
        usage: UsageHint::default(),
    };
    let mut b = a.clone();
    b.body = "B body".into();

    let ra = build_signed_receipt("req-x", "notify.compose.email", "m", &a);
    let rb = build_signed_receipt("req-x", "notify.compose.email", "m", &b);
    assert_ne!(ra["response_hash"], rb["response_hash"]);
    // We only assert the response_hash differs; receipt_id may also differ
    // because timestamp moves between the two calls. Either way a tampered
    // body invalidates the chain.
}

#[test]
fn extract_json_object_returns_first_balanced_object() {
    let raw = r#"prefix {"a":1} {"b":2} suffix"#;
    let extracted = extract_json_object(raw).expect("found");
    assert_eq!(extracted, r#"{"a":1}"#);
}

#[test]
fn extract_json_object_handles_strings_with_braces() {
    let raw = r#"{"key":"} not the end"}"#;
    let extracted = extract_json_object(raw).expect("found");
    assert_eq!(extracted, r#"{"key":"} not the end"}"#);
}
