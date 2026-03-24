// Fingerprint algorithm v1 — must stay in sync with web/lib/ai/fingerprint.ts
//
// Normalization steps (ORDER MATTERS for cross-language determinism):
//   1. Concatenate title + body, lowercase
//   2. Strip UUIDs (before epochs — UUIDs contain digit sequences)
//   3. Strip ISO 8601 timestamps (lowercase t)
//   4. Strip Unix epochs (10+ digits)
//   5. Strip relative times ("5 minutes ago")
//   6. Strip hex IDs (>8 chars)
//   7. Strip file paths (/foo/bar.ts)
//   8. Strip line numbers (at line 42, :42:10)
//   9. Strip URLs
//  10. Strip version numbers (v1.2.3)
//  11. Collapse whitespace, trim
//  12. SHA-256 → hex string (64 chars)

use regex::Regex;
use sha2::{Digest, Sha256};

/// Compute a deterministic fingerprint for an error pattern.
/// Same error class (regardless of timestamps, IDs, paths) → same hash.
pub fn compute_error_fingerprint(title: &str, body: &str) -> String {
    let input = format!("{}\n{}", title, body).to_lowercase();

    let normalized = normalize_error_text(&input);

    let hash = Sha256::digest(normalized.as_bytes());
    format!("{:x}", hash)
}

fn normalize_error_text(input: &str) -> String {
    let mut s = input.to_string();

    // 2. UUIDs (before epochs — UUIDs contain digit sequences that epoch regex would eat)
    let re_uuid =
        Regex::new(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").unwrap();
    s = re_uuid.replace_all(&s, "<uuid>").to_string();

    // 3. ISO 8601 timestamps (lowercase t — input is already lowercased)
    let re_iso = Regex::new(r"\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}[^\s]*").unwrap();
    s = re_iso.replace_all(&s, "<timestamp>").to_string();

    // 4. Unix epochs (10-13 digits)
    let re_epoch = Regex::new(r"\b\d{10,13}\b").unwrap();
    s = re_epoch.replace_all(&s, "<timestamp>").to_string();

    // 5. Relative times
    let re_rel = Regex::new(r"\b\d+\s*(ms|seconds?|minutes?|hours?|days?)\s*ago\b").unwrap();
    s = re_rel.replace_all(&s, "<time_ago>").to_string();

    // 6. Hex IDs (>8 chars)
    let re_hex = Regex::new(r"\b[0-9a-f]{9,}\b").unwrap();
    s = re_hex.replace_all(&s, "<hex_id>").to_string();

    // 7. File paths
    let re_path = Regex::new(r"(?:/[\w.\-]+){2,}(?:\.\w+)?").unwrap();
    s = re_path.replace_all(&s, "<path>").to_string();

    // 8. Line numbers
    let re_line = Regex::new(r"(?:at line|line:?|:\d+:\d+)\s*\d+").unwrap();
    s = re_line.replace_all(&s, "at line <N>").to_string();

    // 9. URLs
    let re_url = Regex::new(r"https?://[^\s)]+").unwrap();
    s = re_url.replace_all(&s, "<url>").to_string();

    // 10. Version numbers
    let re_ver = Regex::new(r"v?\d+\.\d+\.\d+[^\s]*").unwrap();
    s = re_ver.replace_all(&s, "<version>").to_string();

    // 11. Collapse whitespace
    let re_ws = Regex::new(r"\s+").unwrap();
    re_ws.replace_all(&s, " ").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_input_same_hash() {
        let a = compute_error_fingerprint("TypeError: x is null", "at UserProfile.tsx:42");
        let b = compute_error_fingerprint("TypeError: x is null", "at UserProfile.tsx:42");
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn different_timestamps_same_hash() {
        let a = compute_error_fingerprint(
            "Error at 2024-01-15T10:30:00Z",
            "deploy failed",
        );
        let b = compute_error_fingerprint(
            "Error at 2026-03-24T15:00:00Z",
            "deploy failed",
        );
        assert_eq!(a, b);
    }

    #[test]
    fn different_uuids_same_hash() {
        let a = compute_error_fingerprint(
            "Failed for user a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            "",
        );
        let b = compute_error_fingerprint(
            "Failed for user 11111111-2222-3333-4444-555555555555",
            "",
        );
        assert_eq!(a, b);
    }

    #[test]
    fn different_line_numbers_same_hash() {
        let a = compute_error_fingerprint("TypeError", "at line 42 in render()");
        let b = compute_error_fingerprint("TypeError", "at line 999 in render()");
        assert_eq!(a, b);
    }

    #[test]
    fn different_paths_same_hash() {
        let a = compute_error_fingerprint("Error in /src/components/UserProfile.tsx", "");
        let b = compute_error_fingerprint("Error in /src/pages/Dashboard.tsx", "");
        assert_eq!(a, b);
    }

    #[test]
    fn different_versions_same_hash() {
        let a = compute_error_fingerprint("next@14.1.0 build failed", "");
        let b = compute_error_fingerprint("next@15.0.3 build failed", "");
        assert_eq!(a, b);
    }

    #[test]
    fn empty_input_stable() {
        let a = compute_error_fingerprint("", "");
        let b = compute_error_fingerprint("", "");
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn different_errors_different_hash() {
        let a = compute_error_fingerprint("TypeError: x is null", "");
        let b = compute_error_fingerprint("SyntaxError: unexpected token", "");
        assert_ne!(a, b);
    }
}
