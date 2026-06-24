//! Session 4 — `get_logs` parses + filters + caps log entries.
//!
//! The IPC command resolves the log directory via Tauri's
//! `app.path().app_log_dir()`; we can't drive that without a Tauri app
//! handle. Instead we exercise the parsing/filter/cap logic directly
//! by reading a synthetic file with `fs::read_to_string` and applying
//! the same code path the command uses inline.

use std::io::Write;

const LOG_ENTRIES_CAP: usize = 200;

fn parse_level(line: &str) -> String {
    for token in [" ERROR ", " WARN ", " INFO ", " DEBUG ", " TRACE "] {
        if line.contains(token) {
            return token.trim().to_lowercase();
        }
    }
    "unknown".to_string()
}

fn read_and_filter(path: &std::path::Path, level: Option<&str>) -> Vec<(String, String)> {
    let contents = std::fs::read_to_string(path).expect("read");
    let filter = level.map(|s| s.to_lowercase());
    let mut entries: Vec<(String, String)> = contents
        .lines()
        .map(|line| (line.to_string(), parse_level(line)))
        .filter(|(_, lv)| match &filter {
            Some(want) => lv == want,
            None       => true,
        })
        .collect();
    if entries.len() > LOG_ENTRIES_CAP {
        let drop = entries.len() - LOG_ENTRIES_CAP;
        entries.drain(..drop);
    }
    entries
}

#[test]
fn parses_levels_from_tracing_format() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let log = tmp.path().join("inari-live.log");
    let mut f = std::fs::File::create(&log).expect("create");
    writeln!(f, "2026-04-29T12:00:00.000Z  INFO inariwatch_desktop_lib::store: store opened").unwrap();
    writeln!(f, "2026-04-29T12:00:01.000Z  WARN inariwatch_desktop_lib::ipc: legacy settings warning").unwrap();
    writeln!(f, "2026-04-29T12:00:02.000Z  ERROR inariwatch_desktop_lib::cloud: poll failure").unwrap();
    writeln!(f, "2026-04-29T12:00:03.000Z  DEBUG inariwatch_desktop_lib::daemon: heartbeat").unwrap();
    drop(f);

    let all = read_and_filter(&log, None);
    assert_eq!(all.len(), 4);
    assert_eq!(all[0].1, "info");
    assert_eq!(all[1].1, "warn");
    assert_eq!(all[2].1, "error");
    assert_eq!(all[3].1, "debug");
}

#[test]
fn filter_by_level_returns_only_matching() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let log = tmp.path().join("inari-live.log");
    let mut f = std::fs::File::create(&log).expect("create");
    for i in 0..10 {
        let lvl = if i % 2 == 0 { "INFO" } else { "WARN" };
        writeln!(f, "2026-04-29T12:00:{:02}.000Z  {} test message", i, lvl).unwrap();
    }
    drop(f);

    let warns = read_and_filter(&log, Some("warn"));
    assert_eq!(warns.len(), 5);
    for (_, lv) in &warns {
        assert_eq!(lv, "warn");
    }
}

#[test]
fn caps_at_200_entries() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let log = tmp.path().join("inari-live.log");
    let mut f = std::fs::File::create(&log).expect("create");
    for i in 0..500 {
        writeln!(f, "2026-04-29T12:00:00.000Z  INFO test: line {}", i).unwrap();
    }
    drop(f);

    let entries = read_and_filter(&log, None);
    assert_eq!(entries.len(), LOG_ENTRIES_CAP, "must cap at 200");

    // Verify we kept the TAIL (most recent), not the head.
    assert!(
        entries
            .last()
            .unwrap()
            .0
            .contains("line 499"),
        "tail-of-file ordering: last cap entry must be most recent"
    );
}

#[test]
fn unknown_level_when_format_does_not_match() {
    assert_eq!(parse_level("plain text without tracing token"), "unknown");
    assert_eq!(parse_level("not a real log line"), "unknown");
}
