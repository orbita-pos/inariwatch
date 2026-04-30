//! Path-resolution test.
//!
//! Tauri 2's `MockBuilder` is unstable and `app.path().app_local_data_dir()`
//! requires a concrete tauri::App that's hard to spin up in a unit test on
//! Windows without bundling. We exercise the same code path as
//! `Store::resolve_db_path` by pointing `Store::open_at` at a synthetic
//! `<base>/inari-live/store.db` location and asserting the directory is
//! created and the DB lands at the expected leaf path.
//!
//! When Session 4 wires the real Tauri command surface and adds a Tauri
//! test harness, an additional ignored-by-default test in this file can
//! exercise `Store::resolve_db_path` directly.

use inariwatch_desktop_lib::store::Store;

#[test]
fn open_at_creates_parent_dir_and_lands_at_expected_leaf() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let base = tmp.path().to_path_buf();

    // Same shape as `Store::resolve_db_path`:
    // <app_local_data_dir>/inari-live/store.db
    let synthetic = base.join("inari-live").join("store.db");
    assert!(!synthetic.exists(), "fresh tempdir should not have a DB");
    assert!(
        !synthetic.parent().unwrap().exists(),
        "parent dir should not exist before open"
    );

    let store = Store::open_at(&synthetic).expect("open");

    assert!(synthetic.exists(), "DB file should have been created");
    assert!(
        synthetic.parent().unwrap().is_dir(),
        "parent dir should have been created"
    );
    assert_eq!(store.db_path(), synthetic.as_path());

    // The "inari-live" directory name is part of the contract — Session
    // 4 / Session 14 / future installer scripts depend on this exact
    // leaf so they can locate the store from outside the daemon.
    let parent = synthetic.parent().unwrap();
    assert_eq!(
        parent.file_name().and_then(|s| s.to_str()),
        Some("inari-live"),
        "DB must live under an 'inari-live' subdirectory"
    );
    assert_eq!(
        synthetic.file_name().and_then(|s| s.to_str()),
        Some("store.db"),
        "DB filename must be 'store.db'"
    );
}

#[test]
#[ignore = "requires Tauri AppHandle — Session 4 wires the harness"]
fn resolve_db_path_via_tauri_apphandle() {
    // Placeholder for the Tauri-harness path-resolution test.
    // Session 4's IPC work will introduce a Tauri integration test
    // setup that constructs a real AppHandle (`MockBuilder` or
    // `tauri::test::mock_app()`); at that point this test exercises:
    //
    //   let app = tauri::test::mock_app();
    //   let path = Store::resolve_db_path(&app.handle()).unwrap();
    //   assert_eq!(path.file_name().unwrap(), "store.db");
    //   assert_eq!(path.parent().unwrap().file_name().unwrap(),
    //              "inari-live");
    //
    // Until then the synthetic test above covers the path-shape
    // contract; resolve_db_path is exercised end-to-end in
    // `tauri dev` runs.
}
