//! Pure tray menu builder. Decoupled from the click handlers so the
//! menu structure can be unit-tested without spinning up a tray
//! (which needs a real Tauri runtime).

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::Wry;

use super::handlers::TrayMenuItem;

/// Bundle returned by [`build_menu`]. The `pause_handle` is needed
/// outside the menu builder so the click handler can flip its label
/// between "Pause watch" / "Resume watch".
///
/// Pinned to `Wry` because that's the only runtime the production
/// binary uses; making it generic on `R` would force every consumer
/// (tray installer, future tests, …) to thread a parameter for no
/// benefit.
pub struct TrayMenu {
    pub menu: Menu<Wry>,
    pub pause_handle: MenuItem<Wry>,
}

/// Build the full tray menu. `paused` controls the initial label of
/// the "Pause watch" item.
///
/// Layout:
///
/// 1. Open InariWatch / Open Inari Live / Open dashboard…
/// 2. Quick Actions ▶ (Fix / Investigate / Open stacktrace / Audit)
/// 3. Pause watch / Pause sensors / Settings…
/// 4. Quit
pub fn build_menu<M: tauri::Manager<Wry>>(app: &M, paused: bool) -> tauri::Result<TrayMenu> {
    let open = MenuItem::with_id(
        app,
        TrayMenuItem::Open.id(),
        "Open InariWatch",
        true,
        None::<&str>,
    )?;
    let inari = MenuItem::with_id(
        app,
        TrayMenuItem::Inari.id(),
        "Open Inari Live",
        true,
        None::<&str>,
    )?;
    let dashboard = MenuItem::with_id(
        app,
        TrayMenuItem::Dashboard.id(),
        "Open dashboard…",
        true,
        None::<&str>,
    )?;

    let sep1 = PredefinedMenuItem::separator(app)?;

    let quick_fix = MenuItem::with_id(
        app,
        TrayMenuItem::QuickFix.id(),
        "Fix Last Alert",
        true,
        None::<&str>,
    )?;
    let quick_investigate = MenuItem::with_id(
        app,
        TrayMenuItem::QuickInvestigate.id(),
        "Investigate Last",
        true,
        None::<&str>,
    )?;
    let quick_stacktrace = MenuItem::with_id(
        app,
        TrayMenuItem::QuickOpenStacktrace.id(),
        "Open Latest Stacktrace in Editor",
        true,
        None::<&str>,
    )?;
    let quick_audit = MenuItem::with_id(
        app,
        TrayMenuItem::QuickShowAudit.id(),
        "Show Audit Log",
        true,
        None::<&str>,
    )?;
    let quick_actions = Submenu::with_id_and_items(
        app,
        "quick",
        "Quick Actions",
        true,
        &[&quick_fix, &quick_investigate, &quick_stacktrace, &quick_audit],
    )?;

    let sep2 = PredefinedMenuItem::separator(app)?;

    let pause_label = if paused { "Resume watch" } else { "Pause watch" };
    let pause = MenuItem::with_id(
        app,
        TrayMenuItem::Pause.id(),
        pause_label,
        true,
        None::<&str>,
    )?;
    let pause_sensors = MenuItem::with_id(
        app,
        TrayMenuItem::PauseSensors.id(),
        "Pause sensors",
        true,
        None::<&str>,
    )?;
    let settings = MenuItem::with_id(
        app,
        TrayMenuItem::Settings.id(),
        "Settings…",
        true,
        None::<&str>,
    )?;

    let sep3 = PredefinedMenuItem::separator(app)?;

    let quit = MenuItem::with_id(app, TrayMenuItem::Quit.id(), "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &open,
            &inari,
            &dashboard,
            &sep1,
            &quick_actions,
            &sep2,
            &pause,
            &pause_sensors,
            &settings,
            &sep3,
            &quit,
        ],
    )?;

    Ok(TrayMenu {
        menu,
        pause_handle: pause,
    })
}
