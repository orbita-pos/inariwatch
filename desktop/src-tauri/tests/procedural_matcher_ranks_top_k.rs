//! Sesión 12 — matcher ranking + on-disk roundtrip.
//!
//! Writes a synthetic `.inari/patterns.json` directly (bypassing the
//! learner — the matcher is independent), then exercises:
//!   * `top_k = 5` truncation
//!   * `include_anti_patterns = false` filter
//!   * recency override of raw success rate
//!   * roundtrip byte-identical on save → load → save

use std::sync::Arc;

use inariwatch_desktop_lib::memory::procedural::{
    learner::{load_patterns, patterns_path, save_patterns},
    match_patterns, MatchOptions, Pattern, PatternKind, PatternsFile, CURRENT_VERSION,
};
use inariwatch_desktop_lib::store::queries::upsert_repo;
use inariwatch_desktop_lib::store::Store;

const REPO_ID:     &str = "repo-procedural-matcher";
const FINGERPRINT: &str = "fp_target";
const DAY_MS:      i64  = 86_400_000;

fn open_store_and_repo() -> (Arc<Store>, tempfile::TempDir) {
    let dir   = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(
        Store::open_at(&dir.path().join("inari.db")).expect("open store"),
    );
    let repo_path = dir.path().to_string_lossy().into_owned();
    upsert_repo(&store, REPO_ID, &repo_path, "matcher-test", 0).unwrap();
    (store, dir)
}

fn pat(kind: PatternKind, fp: &str, succ: u32, fail: u32, last_seen_ms: i64) -> Pattern {
    Pattern {
        kind,
        fingerprint:           fp.to_string(),
        suggested_fix_summary: format!("fix for {fp}"),
        success_count:         succ,
        failure_count:         fail,
        evidence:              Vec::new(),
        last_seen_ms,
        created_at_ms:         0,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn top_k_truncates_and_excludes_anti_patterns() {
    let (store, repo_dir) = open_store_and_repo();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    // 100 synthetic patterns: 50 with FP_TARGET (mixed kinds + ages),
    // 50 with other fingerprints (must NEVER be in the result).
    let mut patterns = Vec::with_capacity(100);
    for i in 0..50 {
        // Mostly auto-detected, every 10th is anti-pattern.
        let kind = if i % 10 == 0 { PatternKind::AntiPattern } else { PatternKind::AutoDetected };
        // Ages: spread 0..50 days.
        let age_days = i as i64;
        patterns.push(pat(kind, FINGERPRINT, (i + 1) as u32, 0, now - age_days * DAY_MS));
    }
    for i in 0..50 {
        patterns.push(pat(PatternKind::AutoDetected, "other_fp", 99, 0, now));
        let _ = i;
    }

    let file = PatternsFile { version: CURRENT_VERSION, patterns };
    let path = patterns_path(repo_dir.path());
    save_patterns(&path, &file).unwrap();

    // top_k=5, exclude anti-patterns.
    let r = match_patterns(
        &store,
        REPO_ID,
        FINGERPRINT,
        MatchOptions { top_k: 5, include_anti_patterns: false, ..Default::default() },
    )
    .await
    .unwrap();
    assert_eq!(r.len(), 5);
    for m in &r {
        assert_eq!(m.pattern.fingerprint, FINGERPRINT);
        assert_ne!(m.pattern.kind, PatternKind::AntiPattern,
            "anti-patterns must not appear when include_anti_patterns=false");
    }
    // Descending order.
    for w in r.windows(2) {
        assert!(w[0].score >= w[1].score, "results must be sorted descending by score");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fresh_high_rate_outranks_stale_perfect() {
    let (store, repo_dir) = open_store_and_repo();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    let patterns = vec![
        // Fresh, 90% success (9/10): score ≈ 0.9 * 1.0 = 0.9
        pat(PatternKind::AutoDetected, FINGERPRINT, 9, 1, now),
        // Stale (60 days), 100% success (1/1): score ≈ 1.0 * 0.5^(60/30) = 0.25
        pat(PatternKind::AutoDetected, FINGERPRINT, 1, 0, now - 60 * DAY_MS),
    ];
    let file = PatternsFile { version: CURRENT_VERSION, patterns };
    let path = patterns_path(repo_dir.path());
    save_patterns(&path, &file).unwrap();

    let r = match_patterns(&store, REPO_ID, FINGERPRINT, MatchOptions::default())
        .await
        .unwrap();
    assert_eq!(r.len(), 2);
    assert_eq!(r[0].pattern.success_count, 9, "fresh-high-rate must rank first");
    assert!(r[0].score > r[1].score);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn save_load_save_is_byte_identical() {
    let (_store, repo_dir) = open_store_and_repo();
    let path = patterns_path(repo_dir.path());

    let file = PatternsFile {
        version:  CURRENT_VERSION,
        patterns: vec![
            pat(PatternKind::AutoDetected, "fp_a", 3, 1, 1_700_000_000_000),
            pat(PatternKind::AntiPattern,  "fp_b", 0, 5, 1_700_000_001_000),
            pat(PatternKind::AutoDetected, "fp_c", 7, 0, 1_700_000_002_000),
        ],
    };
    save_patterns(&path, &file).unwrap();
    let body1 = std::fs::read(&path).unwrap();
    let reloaded = load_patterns(&path).unwrap();
    save_patterns(&path, &reloaded).unwrap();
    let body2 = std::fs::read(&path).unwrap();
    assert_eq!(body1, body2, "save → load → save MUST be byte-identical");

    // Spot-check the canonical key order: version key precedes patterns.
    let s = std::str::from_utf8(&body1).unwrap();
    let v_pos = s.find("\"version\":").expect("version key");
    let p_pos = s.find("\"patterns\":").expect("patterns key");
    assert!(v_pos < p_pos, "version must precede patterns in JSON output");
    // Inside a Pattern, kind precedes fingerprint precedes success_count.
    let kind_pos = s.find("\"kind\":").expect("kind key");
    let fp_pos = s.find("\"fingerprint\":").expect("fingerprint key");
    assert!(kind_pos < fp_pos, "kind must precede fingerprint");
}
