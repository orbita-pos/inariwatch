//! Session 4 — TOML→SQL legacy settings migration.
//!
//! Three properties:
//! - happy path: every key/value pair from the TOML lands as a row in
//!   `settings`, plus a `legacy_settings` JSON blob is stored.
//! - idempotent: running a second time is a no-op (returns
//!   `AlreadyMigrated`) and does not duplicate rows.
//! - no-op when the legacy file is absent.

use std::path::PathBuf;

use inariwatch_desktop_lib::store::legacy_settings_migration::{
    migrate_at, MigrationOutcome,
};
use inariwatch_desktop_lib::store::Store;

fn fresh_store() -> (tempfile::TempDir, Store) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let db = tmp.path().join("inari-live").join("store.db");
    let store = Store::open_at(&db).expect("open store");
    (tmp, store)
}

fn write_legacy_toml(dir: &std::path::Path) -> PathBuf {
    let path = dir.join("desktop.toml");
    let body = "\
# managed by Inari Live
watch_dir       = \"/Users/jb/code/radar\"
dashboard_url   = \"https://app.inariwatch.com\"
dashboard_token = \"sk-fake-12345\"
notifications_enabled = \"true\"
theme           = \"dark\"
";
    std::fs::write(&path, body).expect("write toml");
    path
}

#[test]
fn happy_path_migrates_every_key_and_stores_legacy_json() {
    let (_tmp, store) = fresh_store();
    let toml_dir = tempfile::tempdir().expect("tempdir for toml");
    let path = write_legacy_toml(toml_dir.path());

    let outcome = migrate_at(&store, &path).expect("migrate");
    match outcome {
        MigrationOutcome::Migrated { keys_migrated } => {
            assert_eq!(keys_migrated, 5, "expected 5 keys from fixture TOML");
        }
        other => panic!("expected Migrated, got {:?}", other),
    }

    // Each key landed individually.
    let conn = store.conn().expect("conn");
    let watch_dir: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'watch_dir'",
            [],
            |row| row.get(0),
        )
        .expect("watch_dir row");
    assert_eq!(watch_dir, "/Users/jb/code/radar");

    let token: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'dashboard_token'",
            [],
            |row| row.get(0),
        )
        .expect("token row");
    assert_eq!(token, "sk-fake-12345");

    // legacy_settings JSON blob is also there.
    let legacy: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'legacy_settings'",
            [],
            |row| row.get(0),
        )
        .expect("legacy_settings row");
    assert!(legacy.contains("watch_dir"));
    assert!(legacy.contains("dashboard_token"));

    // Marker row is present.
    let marker_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM settings WHERE key = '__legacy_toml_migrated_at'",
            [],
            |row| row.get(0),
        )
        .expect("marker count");
    assert_eq!(marker_count, 1, "marker should be set after migration");
}

#[test]
fn second_run_is_idempotent() {
    let (_tmp, store) = fresh_store();
    let toml_dir = tempfile::tempdir().expect("tempdir for toml");
    let path = write_legacy_toml(toml_dir.path());

    let first = migrate_at(&store, &path).expect("first migrate");
    assert!(matches!(first, MigrationOutcome::Migrated { .. }));

    // Snapshot row count.
    let count_before: i64 = store
        .conn()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM settings", [], |r| r.get(0))
        .unwrap();

    let second = migrate_at(&store, &path).expect("second migrate");
    assert_eq!(second, MigrationOutcome::AlreadyMigrated);

    let count_after: i64 = store
        .conn()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM settings", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        count_before, count_after,
        "re-running migration must not duplicate rows"
    );
}

#[test]
fn no_op_when_legacy_file_missing() {
    let (_tmp, store) = fresh_store();
    let bogus = std::path::Path::new("/nonexistent/inari-toml-fixture.toml");
    let outcome = migrate_at(&store, bogus).expect("migrate");
    assert_eq!(outcome, MigrationOutcome::NoLegacyFile);

    // No legacy_settings row, no marker.
    let count: i64 = store
        .conn()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM settings WHERE key IN ('legacy_settings', '__legacy_toml_migrated_at')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}
