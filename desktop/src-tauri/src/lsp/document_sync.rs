//! `textDocument/didOpen | didChange | didClose` cache.
//!
//! LSP 3.17 default `positionEncodingKind` is `utf-16` — line/character
//! coordinates are UTF-16 code units. We store UTF-8 strings and convert
//! at the edit boundary. The S22 surface only needs ASCII-correct edits
//! for the regression test; the conversion below is also correct for BMP
//! and astral characters (single + surrogate pair) — covered by unit
//! tests against fixtures with `é` and `🦊`.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Position {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

/// One entry of `DidChangeTextDocumentParams.contentChanges`. When `range`
/// is `None`, the change is a full-document replacement.
#[derive(Debug, Clone, Deserialize)]
pub struct ContentChange {
    #[serde(default)]
    pub range: Option<Range>,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct Document {
    pub uri: String,
    pub language_id: String,
    pub version: i32,
    pub text: String,
}

#[derive(Debug, Default)]
pub struct DocumentStore {
    docs: Mutex<HashMap<String, Document>>,
}

impl DocumentStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn open(&self, uri: String, language_id: String, version: i32, text: String) {
        let mut g = self.docs.lock().expect("DocumentStore mutex poisoned");
        g.insert(
            uri.clone(),
            Document { uri, language_id, version, text },
        );
    }

    pub fn close(&self, uri: &str) {
        let mut g = self.docs.lock().expect("DocumentStore mutex poisoned");
        g.remove(uri);
    }

    pub fn get(&self, uri: &str) -> Option<Document> {
        let g = self.docs.lock().expect("DocumentStore mutex poisoned");
        g.get(uri).cloned()
    }

    pub fn contains(&self, uri: &str) -> bool {
        let g = self.docs.lock().expect("DocumentStore mutex poisoned");
        g.contains_key(uri)
    }

    pub fn len(&self) -> usize {
        let g = self.docs.lock().expect("DocumentStore mutex poisoned");
        g.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Apply an ordered list of `contentChanges`. If any change has
    /// `range == None`, the previous text is replaced wholesale (per LSP
    /// 3.17 — a full-doc change in the array supersedes everything before
    /// it). Returns `Err` if the document has not been opened.
    pub fn apply_changes(
        &self,
        uri: &str,
        version: i32,
        changes: &[ContentChange],
    ) -> Result<(), String> {
        let mut g = self.docs.lock().expect("DocumentStore mutex poisoned");
        let doc = g.get_mut(uri).ok_or_else(|| format!("unknown uri: {uri}"))?;

        for change in changes {
            match &change.range {
                None => {
                    doc.text = change.text.clone();
                }
                Some(range) => {
                    let start = utf16_pos_to_byte(&doc.text, range.start.line, range.start.character);
                    let end   = utf16_pos_to_byte(&doc.text, range.end.line,   range.end.character);
                    if start > end || end > doc.text.len() {
                        return Err(format!("range out of bounds: {start}..{end} of {}", doc.text.len()));
                    }
                    doc.text.replace_range(start..end, &change.text);
                }
            }
        }
        doc.version = version;
        Ok(())
    }
}

/// Convert an LSP UTF-16 (line, character) position to a UTF-8 byte
/// offset inside `text`. Out-of-range positions clamp to the end of the
/// matched line / end of text — same behaviour as the rust-analyzer crate
/// does, and the safest choice when a peer sends junk.
pub fn utf16_pos_to_byte(text: &str, line: u32, character: u32) -> usize {
    let mut byte = 0usize;
    let mut current_line = 0u32;

    // Walk to start of `line`th line.
    while current_line < line {
        match text[byte..].find('\n') {
            Some(off) => {
                byte += off + 1;
                current_line += 1;
            }
            None => return text.len(),
        }
    }

    // Walk UTF-16 code units inside that line (up to the next \n).
    let mut code_units_in = 0u32;
    for (i, c) in text[byte..].char_indices() {
        if code_units_in >= character {
            return byte + i;
        }
        if c == '\n' {
            return byte + i;
        }
        code_units_in += c.len_utf16() as u32;
    }
    text.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pos(line: u32, character: u32) -> Position {
        Position { line, character }
    }

    fn range(s_l: u32, s_c: u32, e_l: u32, e_c: u32) -> Range {
        Range { start: pos(s_l, s_c), end: pos(e_l, e_c) }
    }

    #[test]
    fn open_get_close_roundtrip() {
        let s = DocumentStore::new();
        s.open("file:///a".into(), "rust".into(), 1, "fn main() {}".into());
        let d = s.get("file:///a").unwrap();
        assert_eq!(d.version, 1);
        assert_eq!(d.text, "fn main() {}");
        assert_eq!(s.len(), 1);
        s.close("file:///a");
        assert!(!s.contains("file:///a"));
    }

    #[test]
    fn full_replacement_replaces_text() {
        let s = DocumentStore::new();
        s.open("u".into(), "rust".into(), 1, "old".into());
        s.apply_changes("u", 2, &[ContentChange { range: None, text: "new".into() }]).unwrap();
        assert_eq!(s.get("u").unwrap().text, "new");
        assert_eq!(s.get("u").unwrap().version, 2);
    }

    #[test]
    fn incremental_change_inside_line() {
        let s = DocumentStore::new();
        s.open("u".into(), "rust".into(), 1, "let x = 1;".into());
        s.apply_changes(
            "u",
            2,
            &[ContentChange { range: Some(range(0, 8, 0, 9)), text: "42".into() }],
        )
        .unwrap();
        assert_eq!(s.get("u").unwrap().text, "let x = 42;");
    }

    #[test]
    fn incremental_change_across_lines() {
        let s = DocumentStore::new();
        s.open("u".into(), "rust".into(), 1, "abc\ndef\nghi".into());
        s.apply_changes(
            "u",
            2,
            &[ContentChange { range: Some(range(0, 1, 1, 1)), text: "Z".into() }],
        )
        .unwrap();
        assert_eq!(s.get("u").unwrap().text, "aZef\nghi");
    }

    #[test]
    fn utf16_offset_handles_astral_chars() {
        // 🦊 is U+1F98A — surrogate pair in UTF-16, 4 bytes in UTF-8.
        let text = "x🦊y";
        // Byte offset of 'y' = 1 + 4 = 5.
        // UTF-16 code units before 'y' = 1 (x) + 2 (surrogate) = 3.
        assert_eq!(utf16_pos_to_byte(text, 0, 3), 5);
        // Position past end clamps.
        assert_eq!(utf16_pos_to_byte(text, 0, 999), text.len());
    }

    #[test]
    fn utf16_offset_handles_multibyte_bmp() {
        // é is U+00E9 — 1 UTF-16 code unit, 2 UTF-8 bytes.
        let text = "café";
        assert_eq!(utf16_pos_to_byte(text, 0, 4), text.len());
    }

    #[test]
    fn unknown_uri_returns_error() {
        let s = DocumentStore::new();
        let err = s.apply_changes("missing", 1, &[]).unwrap_err();
        assert!(err.contains("unknown uri"));
    }
}
