//! `memory.md` writer — round-trips a `MemoryDoc` back to a CommonMark string.

use super::parser::MemoryDoc;

#[derive(Debug, Clone)]
pub struct SectionUpdate {
    pub heading: String,
    pub new_body: String,
}

/// Serialize `doc` with the requested `updates`.
pub fn render(doc: &MemoryDoc, updates: &[SectionUpdate]) -> String {
    if updates.is_empty() {
        return doc.source.clone();
    }

    let mut overrides: Vec<Option<String>> = vec![None; doc.sections.len()];
    for u in updates {
        if let Some(idx) = doc.sections.iter().position(|s| s.heading == u.heading) {
            overrides[idx] = Some(normalise_body(&u.new_body));
        }
    }

    let mut out = String::with_capacity(doc.source.len() + 256);

    for (idx, section) in doc.sections.iter().enumerate() {
        if idx == 0 {
            out.push_str(&doc.source[section.body_range.clone()]);
            continue;
        }

        out.push_str(doc.heading_line_of(section));

        if let Some(new_body) = &overrides[idx] {
            out.push_str(new_body);
        } else {
            out.push_str(&doc.source[section.body_range.clone()]);
        }
    }

    out
}

fn normalise_body(raw: &str) -> String {
    let mut s = raw.to_string();
    while s.ends_with(['\n', '\r', ' ', '\t']) {
        s.pop();
    }
    s.push_str("\n\n");
    s
}

/// Returns Ok(()) when no pinned section's body diverges between
/// `before` and `after`; otherwise Err(heading) of the first violation.
pub fn assert_no_pinned_changes(before: &MemoryDoc, after: &MemoryDoc) -> Result<(), String> {
    for after_section in after.sections.iter().filter(|s| {
        matches!(s.marker, super::parser::SectionMarker::Pinned)
    }) {
        let Some(before_section) = before.find_section(&after_section.heading) else {
            return Err(after_section.heading.clone());
        };
        if normalise_for_diff(before.body_of(before_section))
            != normalise_for_diff(after.body_of(after_section))
        {
            return Err(after_section.heading.clone());
        }
    }
    for before_section in before.sections.iter().filter(|s| {
        matches!(s.marker, super::parser::SectionMarker::Pinned)
    }) {
        if after.find_section(&before_section.heading).is_none() {
            return Err(before_section.heading.clone());
        }
    }
    Ok(())
}

fn normalise_for_diff(body: &str) -> String {
    let mut lines: Vec<String> = body
        .lines()
        .map(|l| l.trim_end().to_string())
        .collect();
    while lines.first().map_or(false, |l| l.is_empty()) {
        lines.remove(0);
    }
    while lines.last().map_or(false, |l| l.is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MemoryDocDiff {
    pub changed_sections: Vec<String>,
    pub pinned_violations: Vec<String>,
    pub ai_can_commit: bool,
}
