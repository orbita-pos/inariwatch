//! Sesión 17 — settings KV round-trip.
//!
//! Verifies that the underlying `store::settings::{set, get}` surface
//! that backs every Sesión-17 IPC command persists values across
//! re-opens of the same DB file (so a desktop restart doesn't lose
//! Settings state).

use inariwatch_desktop_lib::store::{settings, Store};

#[test]
fn set_then_get_round_trips_a_value() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let db_path = tmp.path().join("store.db");

    let store = Store::open_at(&db_path).expect("open");
    settings::set(&store, "openai_byok_key", "sk-test-1234567890abcdef")
        .expect("set");
    settings::set(&store, "release_channel", "beta").expect("set channel");

    let got_key = settings::get(&store, "openai_byok_key")
        .expect("get")
        .expect("present");
    let got_channel = settings::get(&store, "release_channel")
        .expect("get")
        .expect("present");

    assert_eq!(got_key, "sk-test-1234567890abcdef");
    assert_eq!(got_channel, "beta");
}

#[test]
fn settings_survive_store_reopen() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let db_path = tmp.path().join("store.db");

    {
        let store = Store::open_at(&db_path).expect("open");
        settings::set(&store, "user_onboarded", "true").expect("set");
        settings::set(&store, "language", "es").expect("set");
    }

    let store2 = Store::open_at(&db_path).expect("re-open");
    let onboarded = settings::get(&store2, "user_onboarded").expect("get");
    let lang = settings::get(&store2, "language").expect("get");

    assert_eq!(onboarded.as_deref(), Some("true"));
    assert_eq!(lang.as_deref(), Some("es"));
}

#[test]
fn empty_string_set_is_treated_as_delete() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = Store::open_at(&tmp.path().join("store.db")).expect("open");

    settings::set(&store, "ephemeral", "value").expect("set");
    assert_eq!(
        settings::get(&store, "ephemeral").expect("get").as_deref(),
        Some("value")
    );

    settings::set(&store, "ephemeral", "").expect("set empty");
    assert!(
        settings::get(&store, "ephemeral").expect("get").is_none(),
        "empty string set must collapse to delete (settings::set contract)"
    );
}
