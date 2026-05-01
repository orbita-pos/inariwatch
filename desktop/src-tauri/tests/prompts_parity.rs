//! Sesión 18 — desktop prompt builders match the web SSOT shape.
//!
//! Reads `web/lib/ai/prompts.ts` and asserts that the exact phrases the
//! desktop's `build_analyze_prompt` emits are also present in the web
//! source. This is a lightweight parity check: byte-identical port is
//! impractical (the web source builds its prompt via TS template
//! literals + helper truncation) but the canonical phrases are stable
//! and worth pinning.

use std::path::PathBuf;

use inariwatch_desktop_lib::ai::prompts::{
    build_analyze_prompt, build_ask_inari_prompt, AlertContext, RepoContext, SYSTEM_OPS,
};

fn web_prompts_source() -> Option<String> {
    // Walk up from the Cargo workspace until we find `web/lib/ai/prompts.ts`.
    // Cargo runs tests from the package directory (`desktop/src-tauri/`).
    let mut here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for _ in 0..5 {
        let candidate = here.join("web").join("lib").join("ai").join("prompts.ts");
        if candidate.exists() {
            return std::fs::read_to_string(candidate).ok();
        }
        if !here.pop() { break; }
    }
    None
}

fn web_chat_service_source() -> Option<String> {
    let mut here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for _ in 0..5 {
        let candidate = here
            .join("web").join("lib").join("services").join("chat.service.ts");
        if candidate.exists() {
            return std::fs::read_to_string(candidate).ok();
        }
        if !here.pop() { break; }
    }
    None
}

#[test]
fn analyze_prompt_canonical_phrases_match_web() {
    let sources = vec!["sentry".to_string()];
    let alert = AlertContext {
        title:               "boom",
        severity:            "critical",
        body:                "stack",
        source_integrations: &sources,
        full_trace_context:  None,
    };
    let messages = build_analyze_prompt(&alert);
    let body     = &messages[0].content;

    // These phrases come straight from web/lib/ai/prompts.ts:171-186.
    let canonical = [
        "Analyze this monitoring alert and provide:",
        "1. Root cause — what most likely caused this (2-3 sentences)",
        "2. Impact — what is affected and who (1-2 sentences)",
        "3. Remediation — 2-4 concrete steps to fix or investigate",
        "RESPONSE CONSTRAINTS:",
        "- Maximum 150 words total. Be concise — every sentence must add information.",
        "- No filler phrases like \"This error indicates\" or \"Based on the alert\". Go straight to the cause.",
        "- No preambles. Start directly with the root cause.",
    ];
    for phrase in canonical {
        assert!(body.contains(phrase), "desktop prompt missing canonical phrase: {phrase:?}");
    }

    if let Some(web_src) = web_prompts_source() {
        for phrase in canonical {
            assert!(
                web_src.contains(phrase),
                "web SSOT does not contain canonical phrase {phrase:?} — desktop port out of sync",
            );
        }
    } else {
        eprintln!("note: web/lib/ai/prompts.ts not found from test cwd — skipping cross-source compare");
    }
}

#[test]
fn ask_inari_system_ops_byte_matches_web_ssot() {
    if let Some(web_src) = web_chat_service_source() {
        // The web SSOT defines SYSTEM_OPS as a backtick string. Our
        // Rust port is `\n`-joined. Compare line-by-line ignoring
        // surrounding whitespace.
        for line in SYSTEM_OPS.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() { continue; }
            assert!(
                web_src.contains(trimmed),
                "web SSOT missing line from desktop SYSTEM_OPS: {trimmed:?}",
            );
        }
    } else {
        eprintln!("note: chat.service.ts not found — skipping SYSTEM_OPS parity check");
    }
}

#[test]
fn ask_inari_prompt_uses_system_ops() {
    let no_files: Vec<String> = vec![];
    let ctx = RepoContext { repo_files: &no_files, memory_md: None, code_context: None };
    let messages = build_ask_inari_prompt("Why is uptime down?", &ctx);
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].content, SYSTEM_OPS);
    assert!(messages[1].content.contains("Why is uptime down?"));
}
