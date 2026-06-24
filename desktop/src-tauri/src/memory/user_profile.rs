//! User profile renderer and lightweight fact extractor.
//!
//! **Renderer** — reads `memory_facts` and produces the markdown string
//! injected as Layer 0 in the context stack. Capped at ~1,500 bytes so
//! the context budget stays sane.
//!
//! **Extractor** — rule-based scan of a user message for new facts.
//! Runs synchronously (< 1 ms) after each user turn, producing zero or
//! more `UpsertFact` candidates. The IPC command fires this and persists
//! the results.  A future session can add an LLM pass on top of these
//! rules when the rule-based layer starts missing subtle signals.

use crate::store::memory_facts::{FactRow, FactSource, FactType, UpsertFact};

const MAX_PROFILE_BYTES: usize = 1_500;

// ── Renderer ─────────────────────────────────────────────────────────

/// Render all facts as a concise markdown profile block.
/// Returns `None` when there are no facts to show.
pub fn render(facts: &[FactRow]) -> Option<String> {
    if facts.is_empty() { return None; }

    let mut out = String::with_capacity(512);
    out.push_str("## About you\n");

    let identity: Vec<_>   = facts.iter().filter(|f| f.fact_type == FactType::Identity).collect();
    let prefs: Vec<_>      = facts.iter().filter(|f| f.fact_type == FactType::Preference).collect();
    let patterns: Vec<_>   = facts.iter().filter(|f| f.fact_type == FactType::Pattern).collect();
    let skills: Vec<_>     = facts.iter().filter(|f| f.fact_type == FactType::Skill).collect();
    let context: Vec<_>    = facts.iter().filter(|f| f.fact_type == FactType::Context).collect();

    append_section(&mut out, "Identity",    &identity);
    append_section(&mut out, "Preferences", &prefs);
    append_section(&mut out, "Skills",      &skills);
    append_section(&mut out, "Patterns",    &patterns);
    // Context injected last — most volatile, first to drop if over budget
    append_section(&mut out, "Context",     &context);

    // Hard cap — trim at the last newline before the limit.
    if out.len() > MAX_PROFILE_BYTES {
        let safe = &out[..MAX_PROFILE_BYTES];
        if let Some(pos) = safe.rfind('\n') {
            out.truncate(pos);
            out.push_str("\n_(profile truncated)_");
        } else {
            out.truncate(MAX_PROFILE_BYTES);
        }
    }

    if out.trim() == "## About you" { return None; }
    Some(out)
}

fn append_section(out: &mut String, label: &str, facts: &[&FactRow]) {
    if facts.is_empty() { return; }
    out.push('\n');
    out.push_str("**");
    out.push_str(label);
    out.push_str("**\n");
    for f in facts {
        out.push_str("- ");
        out.push_str(&f.content);
        out.push('\n');
    }
}

// ── Rule-based extractor ─────────────────────────────────────────────

/// Lightweight synchronous fact extractor.
///
/// Scans `message` for patterns that reveal something stable about the
/// user and returns candidate facts for upsert. Runs in < 1 ms — no
/// LLM call needed for this pass.
///
/// Conservative by design: only fires on unambiguous signals. A future
/// LLM pass can catch subtler signals.
pub fn extract_from_message(message: &str) -> Vec<UpsertFact> {
    let mut facts = Vec::new();
    let msg = message.trim();
    if msg.is_empty() { return facts; }

    let lower = msg.to_lowercase();

    // ── Identity ─────────────────────────────────────────────────────

    // "I'm a/I am a [role]"
    for pat in &["i'm a ", "i am a ", "i'm an ", "i am an "] {
        if let Some(pos) = lower.find(pat) {
            let rest = msg[pos + pat.len()..].trim();
            if let Some(noun) = extract_noun_phrase(rest) {
                facts.push(upsert_candidate(FactType::Identity, noun, 0.75));
            }
        }
    }

    // "my name is X" / "call me X"
    for pat in &["my name is ", "call me "] {
        if let Some(pos) = lower.find(pat) {
            let rest = msg[pos + pat.len()..].trim();
            if let Some(name) = first_word(rest) {
                if !name.is_empty() && name.len() < 40 {
                    facts.push(upsert_candidate(FactType::Identity, format!("Name: {name}"), 0.95));
                }
            }
        }
    }

    // ── Stack / tech signals ──────────────────────────────────────────

    // "I use/I'm using [tech]"
    for pat in &["i use ", "i'm using ", "i am using ", "we use ", "we're using "] {
        if let Some(pos) = lower.find(pat) {
            let rest = msg[pos + pat.len()..].trim();
            if let Some(tech) = extract_tech_phrase(rest) {
                facts.push(upsert_candidate(FactType::Preference, format!("Uses {tech}"), 0.8));
            }
        }
    }

    // "built with / powered by [tech]"
    for pat in &["built with ", "powered by ", "running on "] {
        if let Some(pos) = lower.find(pat) {
            let rest = msg[pos + pat.len()..].trim();
            if let Some(tech) = extract_tech_phrase(rest) {
                facts.push(upsert_candidate(FactType::Preference, format!("Uses {tech}"), 0.7));
            }
        }
    }

    // ── Communication preferences ─────────────────────────────────────

    // "keep it / be [adjective]"
    for (pat, pref) in &[
        ("keep it short",    "Prefers terse, short answers"),
        ("keep it brief",    "Prefers terse, short answers"),
        ("be concise",       "Prefers terse, short answers"),
        ("no explanations",  "Prefers no lengthy explanations"),
        ("just the code",    "Prefers code over explanation"),
        ("skip the intro",   "Prefers no intro/outro filler"),
        ("don't explain",    "Prefers code over explanation"),
    ] {
        if lower.contains(pat) {
            facts.push(upsert_candidate(FactType::Preference, pref.to_string(), 0.9));
        }
    }

    // ── Context signals ───────────────────────────────────────────────

    // "I'm working on [project]" / "working on a [thing]"
    for pat in &["working on ", "i'm building ", "i am building "] {
        if let Some(pos) = lower.find(pat) {
            let rest = msg[pos + pat.len()..].trim();
            if let Some(project) = extract_noun_phrase(rest) {
                if project.len() > 3 {
                    facts.push(upsert_candidate(FactType::Context, format!("Working on: {project}"), 0.7));
                }
            }
        }
    }

    // Deduplicate by content
    facts.dedup_by(|a, b| a.content.to_lowercase() == b.content.to_lowercase());
    facts
}

// ── Helpers ───────────────────────────────────────────────────────────

fn upsert_candidate(fact_type: FactType, content: String, confidence: f64) -> UpsertFact {
    UpsertFact {
        fact_type,
        content,
        confidence,
        source: FactSource::Inferred,
        expires_at: None,
    }
}

/// Take the first noun phrase (up to the first comma, period, or line end).
fn extract_noun_phrase(s: &str) -> Option<String> {
    let end = s.find([',', '.', '\n', ';', '!', '?']).unwrap_or(s.len());
    let phrase = s[..end].trim();
    if phrase.is_empty() || phrase.len() > 80 { return None; }
    Some(capitalize_first(phrase))
}

/// Extract a tech name: a single word or "word word" combo up to 40 chars.
fn extract_tech_phrase(s: &str) -> Option<String> {
    let end = s.find([',', '.', '\n', ';', '!', '?', ' ', '(']).unwrap_or(s.len().min(40));
    let word = s[..end].trim();
    if word.is_empty() || word.len() > 40 { return None; }
    Some(word.to_string())
}

fn first_word(s: &str) -> Option<String> {
    let end = s.find([' ', ',', '.', '\n']).unwrap_or(s.len());
    let w = s[..end].trim();
    if w.is_empty() { return None; }
    Some(w.to_string())
}

fn capitalize_first(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        None    => String::new(),
        Some(f) => f.to_uppercase().to_string() + c.as_str(),
    }
}

// ── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_role() {
        let facts = extract_from_message("I'm a solo founder building a SaaS");
        assert!(facts.iter().any(|f| f.fact_type == FactType::Identity));
    }

    #[test]
    fn extracts_tech() {
        let facts = extract_from_message("I use Next.js for the frontend");
        assert!(facts.iter().any(|f| {
            f.fact_type == FactType::Preference && f.content.to_lowercase().contains("next.js")
        }));
    }

    #[test]
    fn extracts_preference() {
        let facts = extract_from_message("keep it short, no explanations please");
        assert!(facts.iter().any(|f| f.fact_type == FactType::Preference));
    }

    #[test]
    fn empty_message_returns_nothing() {
        assert!(extract_from_message("").is_empty());
    }

    #[test]
    fn render_groups_by_type() {
        use crate::store::memory_facts::{FactRow, FactSource, FactType};
        let facts = vec![
            FactRow { id: 1, fact_type: FactType::Identity, content: "Solo founder".into(),
                      confidence: 0.9, source: FactSource::Explicit,
                      created_at: 0, last_seen_at: 0, expires_at: None },
            FactRow { id: 2, fact_type: FactType::Preference, content: "Prefers terse answers".into(),
                      confidence: 0.9, source: FactSource::Inferred,
                      created_at: 0, last_seen_at: 0, expires_at: None },
        ];
        let rendered = render(&facts).unwrap();
        assert!(rendered.contains("Identity"));
        assert!(rendered.contains("Solo founder"));
        assert!(rendered.contains("Preferences"));
    }
}
