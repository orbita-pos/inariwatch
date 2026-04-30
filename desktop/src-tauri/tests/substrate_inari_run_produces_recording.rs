//! Sesión 10 — Test 1: `inari run dev` plan composes correctly and the
//! `.inari/recordings/<id>/` layout the substrate sensor expects is the
//! one the actor's `find_recent_recording` discovers.
//!
//! Per the prompt we drive the public CLI function (no real `node`
//! spawn) and then drop a fixture recording on disk to verify the
//! sensor can resolve it.

use std::path::PathBuf;
use std::time::Duration;

use inariwatch_desktop_lib::cli::run::{compose_node_options, prepare_inari_run};
use inariwatch_desktop_lib::sensors::substrate::{find_recent_recording, recordings_root};

const SAMPLE_PKG: &str = r#"{
  "name": "fixture-app",
  "version": "0.0.0",
  "scripts": {
    "dev": "node server.js"
  }
}"#;

#[test]
fn prepare_inari_run_injects_both_imports_and_picks_dev() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), SAMPLE_PKG).unwrap();

    let plan = prepare_inari_run(dir.path(), None).expect("prepare succeeds");

    // Script default is `dev` (matching the prompt's `inari run dev`).
    assert_eq!(plan.script, "dev");

    // NODE_OPTIONS must mention BOTH imports so the spawned node
    // process loads capture + substrate-agent. This is the contract
    // the wrapper's `compose_node_options()` and the wrapper's
    // `INARI_NODE_OPTIONS_MARKER` both share.
    let (k, v) = plan.env.first().expect("at least NODE_OPTIONS env");
    assert_eq!(k, "NODE_OPTIONS");
    assert!(v.contains("@inariwatch/capture/auto"), "missing capture import: {v}");
    assert!(v.contains("@inariwatch/substrate-agent"), "missing substrate import: {v}");
    assert_eq!(*v, compose_node_options());

    // npm shape — windows uses cmd /C, others use npm directly. Either
    // way, the args end with `run dev`.
    if cfg!(windows) {
        assert_eq!(plan.program, "cmd");
        assert_eq!(plan.args, vec!["/C", "npm", "run", "dev"]);
    } else {
        assert_eq!(plan.program, "npm");
        assert_eq!(plan.args, vec!["run", "dev"]);
    }
    assert_eq!(plan.cwd, dir.path());
}

#[test]
fn prepare_inari_run_rejects_missing_script() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("package.json"),
        r#"{"name":"x","scripts":{"dev":"node ."}}"#,
    ).unwrap();
    let err = prepare_inari_run(dir.path(), Some("nope")).unwrap_err();
    assert!(err.contains("scripts.nope"), "expected error to mention missing script: {err}");
}

#[test]
fn substrate_recordings_layout_matches_sensor_expectation() {
    // Simulate what the substrate-agent runtime would do: write a
    // fresh recording dir at `<repo>/.inari/recordings/<id>/`. The
    // sensor's public helper `find_recent_recording` MUST locate it
    // within the 60s window the actor uses.
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();

    let recording_id = "11111111-2222-3333-4444-555555555555";
    let recording_dir = recordings_root(repo).join(recording_id);
    std::fs::create_dir_all(&recording_dir).unwrap();
    std::fs::write(recording_dir.join("event-1.json"), b"{}").unwrap();

    let found: Option<PathBuf> =
        find_recent_recording(&recordings_root(repo), Duration::from_secs(60)).unwrap();
    let found = found.expect("recent recording should resolve");
    assert_eq!(found.file_name().unwrap(), recording_id);
    // At least one event file present — what the spec asks us to
    // assert per the `.inari/recordings/<id>/` contract.
    let entries: Vec<_> = std::fs::read_dir(&found).unwrap().collect();
    assert!(!entries.is_empty(), "recording dir should contain at least one file");
}
