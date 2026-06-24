//! Sesión 18 — [`BudgetTracker::check`] downgrades or blocks when
//! daily caps are crossed.
//!
//! Variants:
//! - Per-user cap exceeded by Gpt-5.4 call → DowngradeToMini.
//! - Global cap exceeded → Blocked.
//! - Under all caps → Ok.

use std::sync::Arc;

use inariwatch_desktop_lib::ai::budget::{
    BudgetTracker, BudgetVerdict, Model, __set_today_for_tests,
    DEFAULT_PER_USER_CAP_CENTS,
};
use inariwatch_desktop_lib::store::{settings, Store};

fn fresh() -> (Arc<Store>, tempfile::TempDir) {
    let dir   = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open_at(&dir.path().join("store.db")).unwrap());
    (store, dir)
}

#[test]
fn ok_when_under_caps() {
    let (store, _tmp) = fresh();
    let tracker = BudgetTracker::new(store);

    __set_today_for_tests(Some("2026-05-01".to_string()));
    let v = tracker.check(Model::Gpt54, 100, 100).expect("check ok");
    assert_eq!(v, BudgetVerdict::Ok);
    __set_today_for_tests(None);
}

#[test]
fn downgrade_when_per_user_cap_exceeded() {
    let (store, _tmp) = fresh();
    let tracker = BudgetTracker::new(store.clone());
    __set_today_for_tests(Some("2026-05-02".to_string()));

    // Default per-user cap = 100 cents = $1.
    // Pricing for Gpt54 = $10/M completion → 990k completion tokens
    // costs $9.90 = 990 cents — well over the $1 cap. The exact figure
    // doesn't matter for the verdict: any non-trivial spend on the
    // full model crosses the per-user cap.
    tracker.record_actual(Model::Gpt54, 0, 990_000).expect("record");

    // Now any further Gpt54 call exceeds the cap.
    let v = tracker.check(Model::Gpt54, 5_000, 5_000).expect("check ok");
    assert_eq!(v, BudgetVerdict::DowngradeToMini);

    __set_today_for_tests(None);
}

#[test]
fn blocked_when_global_cap_exceeded() {
    let (store, _tmp) = fresh();
    let tracker = BudgetTracker::new(store.clone());
    __set_today_for_tests(Some("2026-05-03".to_string()));

    // Set the global cap to 1 cent so any non-trivial call crosses it.
    settings::set(&store, "ai_global_cap_cents", "1").unwrap();

    let v = tracker.check(Model::Gpt54, 1_000_000, 1_000_000).expect("check ok");
    assert_eq!(v, BudgetVerdict::Blocked);

    __set_today_for_tests(None);
}

#[test]
fn default_per_user_cap_is_one_dollar() {
    assert_eq!(DEFAULT_PER_USER_CAP_CENTS, 100);
}
