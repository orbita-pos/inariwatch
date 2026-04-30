//! `memory.md` parser — extracts heading-level sections plus the
//! `[pinned]` / `[auto-detected]` attributes that drive the
//! AI-can-edit-this gate.

use std::ops::Range;

use pulldown_cmark::{Event, HeadingLevel, Parser, Tag, TagEnd};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SectionMarker {
    None,
    Pinned,
    AutoDetected,
}

impl SectionMarker {
    pub fn from_heading_text(text: &str) -> Self {
        let lc = text.to_ascii_lowercase();
        if lc.contains("[pinned]") {
            SectionMarker::Pinned
        } else if lc.contains("[auto-detected]") {
            SectionMarker::AutoDetected
        } else {
            SectionMarker::None
        }
    }

    pub fn allows_ai_edit(self) -> bool {
        !matches!(self, SectionMarker::Pinned)
    }
}

/// One section of the parsed `memory.md`.
#[derive(Debug, Clone)]
pub struct Section {
    pub heading:       String,
    pub level:         u32,
    pub marker:        SectionMarker,
    pub heading_range: Range<usize>,
    pub body_range:    Range<usize>,
}

/// The parsed document.
#[derive(Debug, Clone)]
pub struct MemoryDoc {
    pub source:   String,
    pub sections: Vec<Section>,
}

impl MemoryDoc {
    pub fn parse(source: impl Into<String>) -> Self {
        let source = source.into();
        let sections = collect_sections(&source);
        Self { source, sections }
    }

    pub fn body_of(&self, section: &Section) -> &str {
        &self.source[section.body_range.clone()]
    }

    pub fn heading_line_of(&self, section: &Section) -> &str {
        &self.source[section.heading_range.clone()]
    }

    pub fn find_section(&self, heading: &str) -> Option<&Section> {
        self.sections.iter().find(|s| s.heading == heading)
    }
}

fn collect_sections(source: &str) -> Vec<Section> {
    let parser = Parser::new(source).into_offset_iter();
    let mut sections: Vec<Section> = Vec::new();

    struct Pending {
        level:  u32,
        text:   String,
        start:  usize,
    }
    let mut pending: Option<Pending> = None;
    let mut last_body_start: Option<usize> = None;
    let mut last_heading_idx: Option<usize> = None;

    sections.push(Section {
        heading:       String::new(),
        level:         0,
        marker:        SectionMarker::None,
        heading_range: 0..0,
        body_range:    0..0,
    });

    for (event, range) in parser {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                pending = Some(Pending {
                    level: heading_level_to_u32(level),
                    text:  String::new(),
                    start: range.start,
                });
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some(p) = pending.take() {
                    let body_start = range.end;
                    let heading_text = p.text.trim().to_string();
                    let marker = SectionMarker::from_heading_text(&heading_text);

                    if let Some(prev_idx) = last_heading_idx {
                        sections[prev_idx].body_range =
                            last_body_start.unwrap_or(body_start)..p.start;
                    } else {
                        sections[0].body_range = 0..p.start;
                    }

                    let section = Section {
                        heading:       heading_text,
                        level:         p.level,
                        marker,
                        heading_range: p.start..body_start,
                        body_range:    body_start..body_start,
                    };
                    sections.push(section);
                    last_body_start  = Some(body_start);
                    last_heading_idx = Some(sections.len() - 1);
                }
            }
            Event::Text(t) | Event::Code(t) => {
                if let Some(ref mut p) = pending {
                    p.text.push_str(&t);
                }
            }
            _ => {}
        }
    }

    if let Some(idx) = last_heading_idx {
        sections[idx].body_range =
            last_body_start.unwrap_or(source.len())..source.len();
    } else {
        sections[0].body_range = 0..source.len();
    }

    sections
}

fn heading_level_to_u32(l: HeadingLevel) -> u32 {
    match l {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}
