//! Session 14 — locks the dock + main window dimensions per spec recap.
//!
//! These constants are the contract the React shell builds against (the
//! `dock.html` body sizes itself to fill 720x480; the chrome anims rely
//! on those exact bounds for the spring reveal). Changing them requires
//! an `INARI_LIVE_DECISIONS.md` entry — this test fails first, forcing
//! the conversation.

use inariwatch_desktop_lib::window;

#[test]
fn dock_dimensions_match_spec() {
    assert_eq!(
        window::dock::DOCK_WIDTH,
        720.0,
        "dock width is locked at 720 per HANDOFF.md spec recap"
    );
    assert_eq!(
        window::dock::DOCK_HEIGHT,
        480.0,
        "dock height is locked at 480 per HANDOFF.md spec recap"
    );
}

#[test]
fn dock_label_matches_session2_canon() {
    assert_eq!(window::dock::DOCK_LABEL, "inari-live-dock");
}

#[test]
fn main_dimensions_match_spec() {
    assert_eq!(window::main::MAIN_WIDTH, 1280.0);
    assert_eq!(window::main::MAIN_HEIGHT, 800.0);
}

#[test]
fn main_label_matches_existing() {
    // Session 14 keeps the existing `main` label so the External-URL
    // dashboard window keeps booting; Session 17 retires the URL but
    // not the label.
    assert_eq!(window::main::MAIN_LABEL, "main");
}
