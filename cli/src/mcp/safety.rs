use regex::Regex;
use std::sync::LazyLock;

/// File patterns the AI must never touch — too risky to auto-patch.
/// Ported from web/lib/ai/remediate.ts BLOCKED_FILE_PATTERNS.
static BLOCKED_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"^\.env(\.|$)",                     // .env, .env.local, .env.production
        r"package-lock\.json$",              // npm lock
        r"yarn\.lock$",                      // yarn lock
        r"pnpm-lock\.yaml$",                 // pnpm lock
        r"bun\.lockb$",                      // bun lock
        r"^\.github/workflows/",             // CI workflows
        r"^\.github/actions/",               // custom actions
        r"\.(sql)$",                         // DB migrations
        r"^(migrations?|db/migrations?)/",   // migration folders
        r"^(terraform|infra)/",              // infrastructure
        r"\.(tf|tfvars)$",                   // Terraform
        r"(?i)Dockerfile",                   // Docker build files
        r"(?i)docker-compose",               // Docker compose
        r"\.(key|pem|cert|p12|pfx)$",        // secrets & certs
    ]
    .iter()
    .map(|p| Regex::new(p).expect("invalid blocked pattern"))
    .collect()
});

/// Returns `true` if the path is safe for the AI to modify.
pub fn is_safe_file_path(path: &str) -> bool {
    // Path traversal checks
    if path.contains("..") || path.starts_with('/') || path.contains('\\') || path.starts_with('~')
    {
        return false;
    }

    // Normalize to forward slashes for matching
    let normalized = path.replace('\\', "/");

    !BLOCKED_PATTERNS.iter().any(|re| re.is_match(&normalized))
}

/// If blocked, returns a human-readable reason.
pub fn blocked_reason(path: &str) -> Option<&'static str> {
    if path.contains("..") || path.starts_with('/') || path.contains('\\') || path.starts_with('~')
    {
        return Some("path traversal or absolute path");
    }

    let normalized = path.replace('\\', "/");
    let reasons: &[(&str, &'static str)] = &[
        (r"^\.env", "environment/secrets file"),
        (r"lock\.", "lock file"),
        (r"\.lockb$", "lock file"),
        (r"\.github/", "CI/CD configuration"),
        (r"\.sql$", "database migration"),
        (r"migrations?/", "database migration"),
        (r"terraform|infra|\.tf", "infrastructure file"),
        (r"Dockerfile|docker-compose", "container configuration"),
        (r"\.(key|pem|cert|p12|pfx)$", "secret/certificate file"),
    ];

    for (pattern, reason) in reasons {
        if let Ok(re) = Regex::new(pattern) {
            if re.is_match(&normalized) {
                return Some(reason);
            }
        }
    }

    if !is_safe_file_path(path) {
        return Some("blocked file pattern");
    }

    None
}

/// Confidence gating levels.
pub const CONFIDENCE_ABORT: u32 = 30;
pub const CONFIDENCE_DRAFT_ONLY: u32 = 70;

/// Auto-merge gate: max lines changed for auto-merge eligibility.
pub const MAX_LINES_FOR_AUTO_MERGE: usize = 200;

/// Self-review score threshold for auto-merge.
pub const MIN_SELF_REVIEW_SCORE: u32 = 70;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_paths() {
        assert!(is_safe_file_path("src/main.rs"));
        assert!(is_safe_file_path("lib/utils/helpers.ts"));
        assert!(is_safe_file_path("components/Button.tsx"));
    }

    #[test]
    fn blocked_paths() {
        assert!(!is_safe_file_path(".env"));
        assert!(!is_safe_file_path(".env.local"));
        assert!(!is_safe_file_path(".env.production"));
        assert!(!is_safe_file_path("package-lock.json"));
        assert!(!is_safe_file_path("yarn.lock"));
        assert!(!is_safe_file_path(".github/workflows/ci.yml"));
        assert!(!is_safe_file_path("migrations/001_init.sql"));
        assert!(!is_safe_file_path("terraform/main.tf"));
        assert!(!is_safe_file_path("Dockerfile"));
        assert!(!is_safe_file_path("server.key"));
    }

    #[test]
    fn traversal_blocked() {
        assert!(!is_safe_file_path("../etc/passwd"));
        assert!(!is_safe_file_path("/etc/passwd"));
        assert!(!is_safe_file_path("~/.ssh/id_rsa"));
        assert!(!is_safe_file_path("src\\..\\etc\\passwd"));
    }
}
