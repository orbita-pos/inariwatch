// Inari Live — file watcher + replay dispatcher
//
// Two layers:
//
//   1. **Activity layer** — `notify` recursive watch on a user-designated
//      project folder. Save → "curious" (or "calculating" when replay
//      configured). Idle 60s → "sleeping". Always on.
//
//   2. **Replay layer** — when `replay_url` + `replay_token` + `recording_url`
//      are present in `desktop.toml`, every coalesced save burst kicks off a
//      single POST to `/v2/replay`. The response drives the fox into
//      `dancing` / `worried` / `scared` based on `throw_reproduced` +
//      `throws.len()`. Without those config keys the layer is dormant —
//      activity layer alone runs.
//
// Graceful degradation:
//   - 503 (binary not yet rsynced to Hetzner): suppress further calls for
//     5 min, fall back to activity-only mode without log spam.
//   - Network / 5xx errors: log once, fall back to "curious".
//   - Single in-flight replay enforced via Arc<AtomicBool>.
//
// `desktop.toml` keys consumed by this module:
//   watch_dir       = "C:/path/to/project"        # required, dormant if unset
//   replay_url      = "https://api.staging.inariwatch.com/v2/replay"
//   replay_token    = "<STAGING_API_SECRET>"
//   # Recording source — pick one:
//   recording_url   = "https://.../api/recordings/<id>/binary"   # static URL
//                                                  # OR — let the desktop discover the latest:
//   dashboard_url   = "https://app.inariwatch.com"       # default, optional
//   dashboard_token = "<desktop-bearer-token>"           # required for auto-discovery
//   project_id      = "<uuid>"                           # optional, narrow to one project
//   # Optional shared by both modes:
//   recording_auth  = "Bearer <token>"            # forwarded to /v2/replay's auth_header.
//                                                  # When using auto-discovery, defaults to
//                                                  # "Bearer <dashboard_token>".
//   repo_url        = "https://github.com/<owner>/<repo>.git"  # optional
//   fix_branch      = "fix/foo"                   # optional
//   github_token    = "ghp_..."                   # optional
//   replay_command  = "node app.js"               # optional, drain-only if absent

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;

use crate::fingerprint::compute_error_fingerprint;
use crate::store::{settings, Store};

const IDLE_TIMEOUT:        Duration = Duration::from_secs(60);
const POLL_INTERVAL:       Duration = Duration::from_millis(500);
const REPLAY_DEBOUNCE:     Duration = Duration::from_secs(1);
const REPLAY_TIMEOUT:      Duration = Duration::from_secs(75);
const BACKEND_DOWN_BACKOFF: Duration = Duration::from_secs(5 * 60);
const DISCOVERY_TTL:       Duration = Duration::from_secs(5 * 60);

/// Process-wide pause flag. Tray menu's "Pause watch" toggles this; the
/// watcher loop honors it at each tick by short-circuiting the event
/// drain. Saves accumulated while paused are dropped (intentional —
/// resuming should not generate a flood of stale replays).
pub static WATCHER_PAUSED: AtomicBool = AtomicBool::new(false);

pub fn is_paused() -> bool {
    WATCHER_PAUSED.load(Ordering::Acquire)
}

pub fn set_paused(p: bool) {
    WATCHER_PAUSED.store(p, Ordering::Release);
}

#[derive(Clone)]
enum RecordingSource {
    /// Static URL pinned in desktop.toml — used verbatim every replay.
    Static { url: String, auth: Option<String> },
    /// Resolve via GET /api/desktop/recordings/latest before each replay.
    /// Result is cached for `DISCOVERY_TTL` so we don't hit the dashboard
    /// on every save burst.
    Dashboard {
        base_url:   String,
        token:      String,
        project_id: Option<String>,
        /// Override for the auth_header forwarded to /v2/replay. When None
        /// we use `Bearer <token>` so the binary endpoint accepts the same
        /// desktop credential.
        auth_override: Option<String>,
    },
}

#[derive(Clone)]
struct ReplayConfig {
    url:            String,
    token:          String,
    source:         RecordingSource,
    repo_url:       Option<String>,
    fix_branch:     Option<String>,
    github_token:   Option<String>,
    command:        Option<String>,
}

#[derive(Clone)]
struct DiscoveredRecording {
    url:           String,
    auth:          Option<String>,
    /// Free-form recording_id (matches `substrate_recordings.recording_id`).
    /// Always Some in Dashboard mode (parsed from A3 response). None in
    /// Static mode unless the user pinned a `recording_id` in TOML.
    recording_id:  Option<String>,
    /// Project this recording belongs to. Used by Inari Live's auto-fix
    /// flow to attribute the synthetic alert. Only Some in Dashboard
    /// mode and when the recording is project-scoped server-side.
    project_id:    Option<String>,
    fetched_at:    Instant,
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Session 5 — settings now live in the SQL store, NOT
        // ~/.config/inari/desktop.toml. The Store is registered in
        // tauri State by `lib.rs::setup` *before* this spawn fires,
        // so the lookup must succeed in production. In test contexts
        // where the daemon spins up without the full Tauri lifecycle
        // (e.g. a Tauri command harness), absence is reported as
        // "dormant" rather than panicking — same behavior as a
        // legacy missing-config TOML.
        let store_state = match app.try_state::<Arc<Store>>() {
            Some(s) => s,
            None    => {
                eprintln!("[inari-watcher] Store not registered in app state — dormant");
                return;
            }
        };
        let cfg = read_config(store_state.inner());

        let watch_dir = match cfg.watch_dir.clone() {
            Some(p) => p,
            None => {
                eprintln!("[inari-watcher] no watch_dir configured — dormant");
                return;
            }
        };

        if !watch_dir.is_dir() {
            eprintln!(
                "[inari-watcher] watch_dir does not exist or is not a directory: {}",
                watch_dir.display()
            );
            return;
        }

        // notify's watcher callback runs on its own thread. Funnel events
        // through a std::mpsc channel so the async loop can poll them.
        let (tx, rx) = mpsc::channel::<()>();

        let mut watcher: RecommendedWatcher = match notify::recommended_watcher(
            move |res: notify::Result<notify::Event>| {
                let Ok(event) = res else { return };
                if matches!(
                    event.kind,
                    EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
                ) && !is_ignored(&event.paths)
                {
                    let _ = tx.send(());
                }
            },
        ) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[inari-watcher] failed to create watcher: {}", e);
                return;
            }
        };

        if let Err(e) = watcher.watch(&watch_dir, RecursiveMode::Recursive) {
            eprintln!(
                "[inari-watcher] failed to watch {}: {}",
                watch_dir.display(),
                e
            );
            return;
        }

        let replay = cfg.replay.clone();
        eprintln!(
            "[inari-watcher] watching {} (replay: {})",
            watch_dir.display(),
            if replay.is_some() { "enabled" } else { "disabled" }
        );

        // Build the http client up front and share it with replay calls.
        let http = Arc::new(
            reqwest::Client::builder()
                .timeout(REPLAY_TIMEOUT)
                .build()
                .expect("reqwest client builds with default config"),
        );

        // Single in-flight replay flag. The watcher loop will not kick a new
        // replay while one is running.
        let replay_in_flight = Arc::new(AtomicBool::new(false));

        // Track when the backend last 503'd so we don't hammer it while the
        // binary isn't deployed yet.
        let backend_unavailable_until: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));

        // Cache the last recording discovered from /api/desktop/recordings/latest.
        let discovered: Arc<Mutex<Option<DiscoveredRecording>>> = Arc::new(Mutex::new(None));

        // Last replay verdict the loop saw. Used to detect the rising edge
        // worried/scared → dancing that triggers /api/desktop/saves.
        let last_replay_state: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        // Stringified watch_dir, captured once for use in save events.
        let watch_dir_str = watch_dir.display().to_string();

        let mut current_state: &'static str = "curious";
        let mut last_activity: Option<Instant> = None;
        let mut pending_replay = false;

        loop {
            // Honor the tray Pause toggle. We still drain the channel so it
            // doesn't grow unbounded while paused — but we don't emit state
            // changes or kick replays.
            if is_paused() {
                while rx.try_recv().is_ok() { /* discard */ }
                tokio::time::sleep(POLL_INTERVAL).await;
                continue;
            }

            // Drain all queued events at once so a save burst (editor writes
            // .swp / temp / final in quick succession) collapses into one
            // state change.
            let mut had_event = false;
            while rx.try_recv().is_ok() {
                had_event = true;
            }

            let now = Instant::now();

            if had_event {
                last_activity = Some(now);

                // Pick the right "active" state. With replay configured we
                // jump straight to "calculating" since the replay is about
                // to fire; otherwise the fox just looks "curious".
                let active_state = if replay.is_some() { "calculating" } else { "curious" };
                if current_state != active_state {
                    let _ = app.emit(
                        "inari:set-state",
                        json!({ "state": active_state, "source": "watcher" }),
                    );
                    current_state = active_state;
                }

                if replay.is_some() {
                    pending_replay = true;
                }
            } else if pending_replay {
                // Wait for a quiet window before kicking the replay so a
                // multi-file save doesn't fire N replays.
                if let Some(t) = last_activity {
                    if now.duration_since(t) >= REPLAY_DEBOUNCE
                        && !replay_in_flight.load(Ordering::Acquire)
                    {
                        pending_replay = false;

                        if let Some(rcfg) = replay.clone() {
                            replay_in_flight.store(true, Ordering::Release);
                            let app2           = app.clone();
                            let http2          = http.clone();
                            let in_flight2     = replay_in_flight.clone();
                            let backend_gate2  = backend_unavailable_until.clone();
                            let discovered2    = discovered.clone();
                            let last_state2    = last_replay_state.clone();
                            let watch_dir2     = watch_dir_str.clone();

                            tauri::async_runtime::spawn(async move {
                                run_replay(
                                    app2, http2, rcfg, backend_gate2, discovered2,
                                    last_state2, watch_dir2,
                                ).await;
                                in_flight2.store(false, Ordering::Release);
                            });
                        }
                    }
                }
            } else if let Some(t) = last_activity {
                if now.duration_since(t) >= IDLE_TIMEOUT && current_state != "sleeping" {
                    let _ = app.emit(
                        "inari:set-state",
                        json!({ "state": "sleeping", "source": "watcher" }),
                    );
                    current_state = "sleeping";
                }
            }

            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
}

// ── Replay dispatch ───────────────────────────────────────────────────────────

#[derive(Serialize)]
struct ReplayRequest {
    recording_url:                String,
    #[serde(skip_serializing_if = "Option::is_none")]
    auth_header:                  Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    repo_url:                     Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fix_branch:                   Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    github_token:                 Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    command:                      Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    timeout_seconds:              Option<u32>,
}

#[derive(Deserialize)]
struct ReplayResponse {
    #[serde(default)]
    throw_reproduced: bool,
    #[serde(default)]
    throws:           Vec<ReplayThrow>,
    #[serde(default)]
    runner_mode:      Option<String>,
    #[serde(default)]
    fix_branch:       Option<String>,
    #[serde(default)]
    duration_ms:      Option<i64>,
}

// Mirrors `inari-staging/internal/orchestrator/replay_v2.go ReplayThrow`.
// Deserialized so we can surface the human-readable parts (exception name,
// message, top stack frames) in Inari's broken-request panel.
#[derive(Deserialize, Serialize, Clone)]
struct ReplayThrow {
    #[serde(default)]
    exception: ReplayException,
    #[serde(default)]
    stack:     Vec<ReplayStackFrame>,
    #[serde(default)]
    ts_rel_ns: u64,
}

#[derive(Deserialize, Serialize, Clone, Default)]
struct ReplayException {
    #[serde(default)]
    name:    String,
    #[serde(default)]
    message: String,
}

#[derive(Deserialize, Serialize, Clone)]
struct ReplayStackFrame {
    #[serde(default)]
    function: String,
    #[serde(default)]
    file:     String,
    #[serde(default)]
    line:     u32,
}

#[derive(Deserialize)]
struct DesktopRecordingsLatest {
    recording_id:  String,
    recording_url: String,
    #[serde(default)]
    project_id:    Option<String>,
}

/// Resolve a `(recording_url, auth_header)` pair for the next /v2/replay call.
///
/// Static source: returns the configured URL/auth verbatim.
///
/// Dashboard source: returns the cached discovery if it's fresher than
/// `DISCOVERY_TTL`, otherwise calls GET /api/desktop/recordings/latest with
/// `Bearer <dashboard_token>` and caches the result. Returns Err on a 204
/// (no recordings yet) or any non-2xx — callers degrade gracefully.
async fn resolve_recording(
    http:       &reqwest::Client,
    cfg:        &ReplayConfig,
    discovered: Arc<Mutex<Option<DiscoveredRecording>>>,
) -> Result<DiscoveredRecording, String> {
    match &cfg.source {
        RecordingSource::Static { url, auth } => Ok(DiscoveredRecording {
            url:          url.clone(),
            auth:         auth.clone(),
            recording_id: None,
            project_id:   None,
            fetched_at:   Instant::now(),
        }),
        RecordingSource::Dashboard { base_url, token, project_id, auth_override } => {
            // Cache hit — return a clone within TTL.
            {
                let cached = discovered.lock().await;
                if let Some(rec) = cached.as_ref() {
                    if rec.fetched_at.elapsed() < DISCOVERY_TTL {
                        return Ok(rec.clone());
                    }
                }
            }

            let mut url = format!(
                "{}/api/desktop/recordings/latest",
                base_url.trim_end_matches('/'),
            );
            if let Some(pid) = project_id {
                url.push_str("?projectId=");
                url.push_str(&urlencode(pid));
            }

            let res = http
                .get(&url)
                .bearer_auth(token)
                .send()
                .await
                .map_err(|e| format!("dashboard fetch: {}", e))?;

            if res.status().as_u16() == 204 {
                return Err("no recordings yet".to_string());
            }
            if !res.status().is_success() {
                return Err(format!(
                    "dashboard returned {}",
                    res.status()
                ));
            }

            let parsed: DesktopRecordingsLatest = res
                .json()
                .await
                .map_err(|e| format!("dashboard body parse: {}", e))?;

            let rec = DiscoveredRecording {
                url:          parsed.recording_url,
                auth:         Some(
                    auth_override
                        .clone()
                        .unwrap_or_else(|| format!("Bearer {}", token)),
                ),
                recording_id: Some(parsed.recording_id),
                project_id:   parsed.project_id,
                fetched_at:   Instant::now(),
            };

            let mut cached = discovered.lock().await;
            *cached = Some(rec.clone());
            Ok(rec)
        }
    }
}

// Minimal URL encoder for the project_id query param. Avoids pulling in a
// whole url crate for one field.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[allow(clippy::too_many_arguments)]
async fn run_replay(
    app:               AppHandle,
    http:              Arc<reqwest::Client>,
    cfg:               ReplayConfig,
    backend_gate:      Arc<Mutex<Option<Instant>>>,
    discovered:        Arc<Mutex<Option<DiscoveredRecording>>>,
    last_replay_state: Arc<Mutex<Option<String>>>,
    watch_dir_str:     String,
) {
    // Honor backend-down backoff: if /v2/replay 503'd recently, skip silently.
    {
        let gate = backend_gate.lock().await;
        if let Some(until) = *gate {
            if Instant::now() < until {
                let _ = app.emit(
                    "inari:set-state",
                    json!({ "state": "curious", "source": "replay-skipped" }),
                );
                return;
            }
        }
    }

    let recording = match resolve_recording(&http, &cfg, discovered).await {
        Ok(r) => r,
        Err(reason) => {
            eprintln!("[inari-watcher] recording resolve failed: {}", reason);
            let _ = app.emit(
                "inari:set-state",
                json!({ "state": "curious", "source": "replay-no-recording" }),
            );
            return;
        }
    };

    // Capture before `recording` is partially moved into `body` below; the
    // ids flow into the final `inari:set-state` payload so JS can wire the
    // auto-fix button without owning the dashboard token.
    let recording_id_for_event = recording.recording_id.clone();
    let project_id_for_event   = recording.project_id.clone();

    let body = ReplayRequest {
        recording_url:    recording.url,
        auth_header:      recording.auth,
        repo_url:         cfg.repo_url.clone(),
        fix_branch:       cfg.fix_branch.clone(),
        github_token:     cfg.github_token.clone(),
        command:          cfg.command.clone(),
        timeout_seconds:  Some(60),
    };

    let res = http
        .post(&cfg.url)
        .bearer_auth(&cfg.token)
        .json(&body)
        .send()
        .await;

    let res = match res {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[inari-watcher] replay request failed: {}", e);
            let _ = app.emit(
                "inari:set-state",
                json!({ "state": "curious", "source": "replay-error" }),
            );
            return;
        }
    };

    let status = res.status();

    if status.as_u16() == 503 {
        // Binary not deployed (Sesión 17 leftover). Mute for 5 min so we
        // don't hammer staging on every save.
        eprintln!("[inari-watcher] /v2/replay 503 — backing off 5 min");
        let mut gate = backend_gate.lock().await;
        *gate = Some(Instant::now() + BACKEND_DOWN_BACKOFF);
        let _ = app.emit(
            "inari:set-state",
            json!({ "state": "curious", "source": "replay-503" }),
        );
        return;
    }

    if !status.is_success() {
        let body_text = res.text().await.unwrap_or_default();
        eprintln!(
            "[inari-watcher] /v2/replay returned {}: {}",
            status,
            truncate(&body_text, 200)
        );
        let _ = app.emit(
            "inari:set-state",
            json!({ "state": "curious", "source": "replay-error" }),
        );
        return;
    }

    let parsed: ReplayResponse = match res.json().await {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[inari-watcher] /v2/replay returned unparseable body: {}", e);
            let _ = app.emit(
                "inari:set-state",
                json!({ "state": "curious", "source": "replay-parse-error" }),
            );
            return;
        }
    };

    let next = if !parsed.throw_reproduced {
        "dancing"
    } else if parsed.throws.len() > 5 {
        "scared"
    } else {
        "worried"
    };

    // Detect "save" rising edge — previous replay was failing, this one
    // passes. Skip when we don't have prior state yet (first replay).
    let prior = {
        let mut last = last_replay_state.lock().await;
        let p = last.clone();
        *last = Some(next.to_string());
        p
    };
    let was_failing = matches!(prior.as_deref(), Some("worried") | Some("scared"));
    if next == "dancing" && was_failing {
        post_save_event(
            &app,
            &http,
            &cfg,
            &watch_dir_str,
            recording_id_for_event.as_deref(),
            prior.as_deref(),
            parsed.throws.len() as i64,
        )
        .await;
    }

    // Surface the head throw + a clipped stack so the JS panel can render
    // the broken-request context without us shuttling the whole array (some
    // crash payloads contain dozens of locals + 50+ frames).
    let head_throw = parsed.throws.first();
    let throw_detail = head_throw.map(|t| {
        let frames: Vec<_> = t
            .stack
            .iter()
            .take(6)
            .map(|f| {
                json!({
                    "function": f.function,
                    "file":     f.file,
                    "line":     f.line,
                })
            })
            .collect();
        json!({
            "exception": {
                "name":    t.exception.name,
                "message": t.exception.message,
            },
            "stack":         frames,
            "stack_total":   t.stack.len(),
            "ts_rel_ns":     t.ts_rel_ns,
        })
    });

    // B2 — when we're in a failing state and we have a Dashboard-mode token,
    // ask the server how the community has fared on this fingerprint.
    // Static-mode users have no token, and dancing/curious states don't
    // need the lookup.
    let community_match = if matches!(next, "worried" | "scared") {
        head_throw
            .and_then(|t| {
                let fp = throw_fingerprint(t);
                Some((fp, t))
            })
            .map(|(fp, _)| fp)
            .and_then(|fp| {
                // Block on the lookup — we're already inside an async fn
                // and the dock should reflect the community match in the
                // same emit so the panel renders together with the throw.
                Some(fp)
            })
    } else {
        None
    };

    let community_match_json = if let Some(fp) = community_match {
        match lookup_pattern_match(&http, &cfg, &fp).await {
            Ok(Some(j)) => Some(j),
            Ok(None) => None,
            Err(e) => {
                eprintln!("[inari-watcher] pattern match lookup failed: {}", e);
                None
            }
        }
    } else {
        None
    };

    let _ = app.emit(
        "inari:set-state",
        json!({
            "state":               next,
            "source":              "replay",
            "throw_reproduced":    parsed.throw_reproduced,
            "throws":              parsed.throws.len(),
            "throw_detail":        throw_detail,
            "community_match":     community_match_json,
            "runner_mode":         parsed.runner_mode,
            "fix_branch":          parsed.fix_branch,
            "duration_ms":         parsed.duration_ms,
            "watch_dir":           &watch_dir_str,
            "recording_id":        recording_id_for_event,
            "recording_project_id": project_id_for_event,
        }),
    );
}

// Build the fingerprint input the same way auto-analyze.ts does for alerts
// (title = exception class, body = message + top stack). Path normalization
// in `compute_error_fingerprint` ensures different repos with the same
// error class still hash the same.
fn throw_fingerprint(t: &ReplayThrow) -> String {
    let title = if t.exception.message.is_empty() {
        t.exception.name.clone()
    } else {
        format!("{}: {}", t.exception.name, t.exception.message)
    };
    let mut body = String::new();
    for f in t.stack.iter().take(3) {
        body.push_str(&format!("at {} {}:{}\n", f.function, f.file, f.line));
    }
    compute_error_fingerprint(&title, &body)
}

// GET /api/desktop/patterns/match?fp=... — Dashboard-mode only. Returns
// Ok(None) on 204 (no community match yet) or any non-2xx so a missing
// pattern isn't a hard error.
async fn lookup_pattern_match(
    http: &reqwest::Client,
    cfg:  &ReplayConfig,
    fp:   &str,
) -> Result<Option<serde_json::Value>, String> {
    let (base_url, token) = match &cfg.source {
        RecordingSource::Dashboard { base_url, token, .. } => (base_url.clone(), token.clone()),
        RecordingSource::Static { .. } => return Ok(None),
    };

    let url = format!(
        "{}/api/desktop/patterns/match?fp={}",
        base_url.trim_end_matches('/'),
        fp,
    );

    let res = http
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("request: {}", e))?;

    if res.status().as_u16() == 204 {
        return Ok(None);
    }
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("parse: {}", e))?;
    Ok(Some(body))
}

// POST /api/desktop/saves — fire-and-forget. Logs on failure but never
// raises. Only fires when the replay source is Dashboard (we need
// dashboard_url + dashboard_token); Static-source users see the counter
// stay at 0 because we don't have credentials to post saves on their
// behalf.
async fn post_save_event(
    app:          &AppHandle,
    http:         &reqwest::Client,
    cfg:          &ReplayConfig,
    watch_dir:    &str,
    recording_id: Option<&str>,
    prior_state:  Option<&str>,
    throws_before: i64,
) {
    let (base_url, token, project_id) = match &cfg.source {
        RecordingSource::Dashboard { base_url, token, project_id, .. } => {
            (base_url.clone(), token.clone(), project_id.clone())
        }
        RecordingSource::Static { .. } => return,
    };

    let url = format!(
        "{}/api/desktop/saves",
        base_url.trim_end_matches('/'),
    );

    let mut body = serde_json::Map::new();
    body.insert("watch_dir".into(), json!(watch_dir));
    if let Some(rid) = recording_id {
        body.insert("recording_id".into(), json!(rid));
    }
    if let Some(pid) = project_id {
        body.insert("project_id".into(), json!(pid));
    }
    if let Some(prev) = prior_state {
        body.insert("prior_state".into(), json!(prev));
    }
    body.insert("throws_before".into(), json!(throws_before));
    body.insert("throws_after".into(), json!(0));

    match http.post(&url).bearer_auth(&token).json(&body).send().await {
        Ok(res) if res.status().is_success() => {
            eprintln!("[inari-watcher] save recorded ({})", res.status());
            // Forward the updated session totals to the dock so the hero
            // stat can animate from the previous value to the fresh one.
            if let Ok(parsed) = res.json::<serde_json::Value>().await {
                if let Some(session) = parsed.get("session") {
                    let _ = app.emit("inari:saved", session.clone());
                }
            }
        }
        Ok(res) => {
            eprintln!("[inari-watcher] save POST returned {}", res.status());
        }
        Err(e) => {
            eprintln!("[inari-watcher] save POST failed: {}", e);
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Ignore changes inside common build/dependency dirs and dotfiles. These
// fire constantly during dev (node_modules churn, .next rebuilds, .git
// index updates) and would keep the fox permanently in "curious".
fn is_ignored(paths: &[PathBuf]) -> bool {
    paths.iter().all(|p| {
        p.components().any(|c| {
            let s = c.as_os_str().to_string_lossy();
            matches!(
                s.as_ref(),
                "node_modules"
                    | ".git"
                    | ".next"
                    | "target"
                    | "dist"
                    | ".nuxt"
                    | ".output"
                    | ".turbo"
                    | ".cache"
                    | ".DS_Store"
            )
        })
    })
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max { s.to_string() } else { format!("{}…", &s[..max]) }
}

// ── Config ────────────────────────────────────────────────────────────────────

struct WatcherConfig {
    watch_dir: Option<PathBuf>,
    replay:    Option<ReplayConfig>,
}

/// Read the watcher's config from the SQL settings store (Session 5
/// migration off `dirs::config_dir()` + `desktop.toml`). The legacy
/// TOML's content is migrated to SQL on first boot via
/// `crate::store::legacy_settings_migration` so existing user data
/// flows through transparently — the keys are identical.
fn read_config(store: &Store) -> WatcherConfig {
    let g = |k: &str| -> Option<String> {
        settings::get(store, k)
            .ok()
            .flatten()
            .filter(|v| !v.is_empty())
    };

    let watch_dir       = g("watch_dir").map(PathBuf::from);
    let replay_url      = g("replay_url");
    let replay_token    = g("replay_token");
    let recording_url   = g("recording_url");
    let recording_auth  = g("recording_auth");
    let dashboard_url   = g("dashboard_url");
    // Session 1 — bearer lives in OS keyring. SecretStore handles the
    // legacy settings-store fallback (and the one-time migration) so
    // pre-S1 installs keep working.
    let dashboard_token = crate::cloud::keyring::SecretStore::new(
            std::sync::Arc::new(store.clone()),
        )
        .token()
        .filter(|v| !v.is_empty());
    let project_id      = g("project_id");
    let repo_url        = g("repo_url");
    let fix_branch      = g("fix_branch");
    let github_token    = g("github_token");
    let command         = g("replay_command");

    // Pick the recording source. Static URL wins if both forms are present
    // (explicit beats implicit). Dashboard mode requires `dashboard_token`;
    // dashboard_url defaults to production.
    let source = if let Some(url) = recording_url {
        Some(RecordingSource::Static { url, auth: recording_auth.clone() })
    } else if let Some(token) = dashboard_token.clone() {
        Some(RecordingSource::Dashboard {
            base_url:      dashboard_url
                .unwrap_or_else(|| "https://app.inariwatch.com".to_string()),
            token,
            project_id,
            auth_override: recording_auth,
        })
    } else {
        None
    };

    let replay = match (replay_url, replay_token, source) {
        (Some(url), Some(token), Some(source)) => Some(ReplayConfig {
            url,
            token,
            source,
            repo_url,
            fix_branch,
            github_token,
            command,
        }),
        _ => None,
    };

    WatcherConfig { watch_dir, replay }
}
