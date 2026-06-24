//! Precedence stack — the ordered set of context inputs an AI prompt
//! gathers before answering a question.

use std::path::Path;

use super::parser::{MemoryDoc, SectionMarker};

pub const MAX_TOTAL_BYTES: usize = 100 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContextLayer {
    /// Layer 0 — structured user profile (Jarvis layer).
    /// Injected first so the AI knows WHO it is talking to before
    /// reading any repo-specific context.
    UserProfile   { content: String },
    ClaudeMd      { content: String },
    AgentsMd      { content: String },
    CursorRules   { content: String },
    MemoryPinned  { sections: Vec<(String, String)> },
    MemoryRest    { sections: Vec<(String, String)> },
    PatternsJson  { content: String },
    SemanticHits  { hits: Vec<String> },
}

impl ContextLayer {
    fn byte_size(&self) -> usize {
        match self {
            ContextLayer::UserProfile  { content } => content.len(),
            ContextLayer::ClaudeMd     { content } => content.len(),
            ContextLayer::AgentsMd     { content } => content.len(),
            ContextLayer::CursorRules  { content } => content.len(),
            ContextLayer::MemoryPinned { sections } |
            ContextLayer::MemoryRest   { sections } => {
                sections.iter().map(|(h, b)| h.len() + b.len() + 4).sum()
            }
            ContextLayer::PatternsJson { content } => content.len(),
            ContextLayer::SemanticHits { hits }    => {
                hits.iter().map(|h| h.len() + 1).sum()
            }
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ContextStack {
    pub layers:    Vec<ContextLayer>,
    pub total_bytes: usize,
    pub truncated: bool,
}

/// Build the context stack for an AI request.
///
/// `user_profile` — pre-rendered markdown from `memory::user_profile::render()`.
/// When `Some`, injected as Layer 0 so the AI knows who it is talking to
/// before reading any repo-specific context.
pub fn gather_context(
    _query:       &str,
    repo_path:    &Path,
    memory:       Option<&MemoryDoc>,
    user_profile: Option<String>,
) -> ContextStack {
    let mut layers: Vec<ContextLayer> = Vec::new();

    // Layer 0 — user identity/preferences (Jarvis layer).
    if let Some(content) = user_profile {
        if !content.trim().is_empty() {
            layers.push(ContextLayer::UserProfile { content });
        }
    }

    if let Some(content) = read_text_file(&repo_path.join("CLAUDE.md")) {
        layers.push(ContextLayer::ClaudeMd { content });
    }
    if let Some(content) = read_text_file(&repo_path.join("AGENTS.md")) {
        layers.push(ContextLayer::AgentsMd { content });
    }
    if let Some(content) = read_text_file(&repo_path.join(".cursorrules")) {
        layers.push(ContextLayer::CursorRules { content });
    }

    if let Some(doc) = memory {
        let (pinned, rest) = split_memory_by_marker(doc);
        if !pinned.is_empty() {
            layers.push(ContextLayer::MemoryPinned { sections: pinned });
        }
        if !rest.is_empty() {
            layers.push(ContextLayer::MemoryRest { sections: rest });
        }
    }

    apply_budget(layers)
}

fn apply_budget(mut layers: Vec<ContextLayer>) -> ContextStack {
    let mut total: usize = layers.iter().map(|l| l.byte_size()).sum();
    let mut truncated = false;

    while total > MAX_TOTAL_BYTES && layers.len() > 1 {
        // Drop order: SemanticHits → PatternsJson → MemoryRest → MemoryPinned.
        // UserProfile and ClaudeMd are preserved until last resort.
        let drop_idx = layers.iter().rposition(|l| matches!(
            l,
            ContextLayer::MemoryRest { .. }
                | ContextLayer::PatternsJson { .. }
                | ContextLayer::SemanticHits { .. }
        ));
        match drop_idx {
            Some(idx) => {
                let removed = layers.remove(idx);
                total -= removed.byte_size();
                truncated = true;
            }
            None => break,
        }
    }

    ContextStack { layers, total_bytes: total, truncated }
}

fn read_text_file(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    String::from_utf8(bytes).ok()
}

fn split_memory_by_marker(doc: &MemoryDoc) -> (Vec<(String, String)>, Vec<(String, String)>) {
    let mut pinned = Vec::new();
    let mut rest   = Vec::new();
    for section in &doc.sections {
        if section.level == 0 || section.heading.is_empty() {
            continue;
        }
        let body = doc.body_of(section).trim().to_string();
        let entry = (section.heading.clone(), body);
        match section.marker {
            SectionMarker::Pinned       => pinned.push(entry),
            SectionMarker::AutoDetected => rest.push(entry),
            SectionMarker::None         => rest.push(entry),
        }
    }
    (pinned, rest)
}
