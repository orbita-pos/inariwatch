# Inari Live — Decision Log

Append-only. Each decision is dated, attributed to a session, and captures *what* was decided and *why* — so a future session can re-read the context without paging back through the master plan.

If a decision conflicts with a fixed constraint in `INARI_LIVE_HANDOFF.md` § *Spec recap*, the fixed constraint wins; the decision must be revised. Decisions that **clarify** spec ambiguities (without contradicting them) are valid.

Format:
```
## YYYY-MM-DD — Sesión N
Decision: <what>
Reason:   <why>
Impact:   <what code / sessions / sequencing this changes>
```

---

## 2026-04-29 — Sesión 1
Decision: Introduce `src-tauri/src/cloud/` as a peer module of `daemon/`, `sensors/`, `memory/`, `ai/`, `ipc/`, `store/`, `window/`, `gates/`, `updater/`, `telemetry/`, `cli/`.
Reason:   The existing scaffold has 4 files (`desktop_auth.rs`, `lib.rs::start_alert_poller`, `saves.rs`, plus future workspace-metadata fetchers) that do cross-cutting cloud-API work and don't fit any spec-named module cleanly. Forcing them under `ipc/` conflates HTTP-to-cloud with IPC-to-webview; nesting them under `daemon/` hides them from independent testing.
Impact:   Sessions 4 and beyond own the moves into `cloud/`. `ARCHITECTURE.md` § *Module split* documents the canonical layout. No spec-recap constraint is violated. Sessions 18-23 (`ai/`, `gates/`, `updater/`, `telemetry/`) are unaffected.

## 2026-04-29 — Sesión 1
Decision: `src/inari_watcher.rs` is split across three modules at end of Session 10, not preserved as a single file.
Reason:   It mixes three concerns (FS watching / `/v2/replay` dispatching / community-pattern lookup) that map cleanly to three separate target modules (`sensors/fs/`, `sensors/substrate/`, `memory/procedural/`). Keeping it as one module would mean `sensors/substrate/` imports from `memory/`, violating the dependency direction.
Reason 2: Session 5 rebuilds the FS sensor with `notify-debouncer-mini` + `ignore` walker — the existing `notify` watch loop is the reference implementation but not the long-term home.
Impact:   Sessions 5, 10, 12 each port their slice. Session 5 does NOT delete `inari_watcher.rs` — Session 10 does, after parity tests confirm the replay path still works.

## 2026-04-29 — Sesión 1
Decision: `src/autofix.rs` is renamed to `ai/remediate/cloud_proxy.rs` (no rewrite) at end of Session 19.
Reason:   The existing autofix bridge IS the "cloud agentic proxied" path Session 19's spec describes. Reusing it verbatim avoids duplicate code.
Impact:   Session 19 implements `single_shot.rs` and `orchestrator.rs` net-new; `cloud_proxy.rs` is a `git mv` + import update. Saves ~6 hours of Session 19 work.

## 2026-04-29 — Sesión 1
Decision: `src/connect.rs` is the prototype for Session A's `inari run <cmd>`. Session 10's substrate wrapper extends it (adds `--import @inariwatch/substrate-agent/auto`).
Reason:   Both flows share identical resolution: bundled npm package → `--import file://` URL → spawn user's dev server. Session A and Session 10 cannot live as independent implementations without duplicating ~250 lines of platform-specific spawning logic.
Impact:   Session 10 implements `sensors/substrate/wrapper.rs` calling into a shared spawner. Session A implements `cli/run.rs` using the same spawner. The spawner lives at `cli/run.rs::spawn_with_imports()` and is imported by both.

## 2026-04-29 — Sesión 1
Decision: `desktop/dist/inari/` (vanilla HTML/JS shell) is preserved as the active Tauri webview source until Session 14, then deleted.
Reason:   It works. Killing it before Session 14 lands the React+Vite shell breaks dogfood. The transition is a single `tauri.conf.json::build.frontendDist` swap + delete the HTML files.
Impact:   Sessions 2-13 keep running against the vanilla shell. The 6 fox SVGs in `dist/inari/assets/` survive the transition (preserved Recraft IP, sunk cost).

## 2026-04-29 — Sesión 1
Decision: A new `dock` window (720×480 transparent + vibrancy + Accessory policy) is created in Session 14, **distinct** from the existing `inari` window (480×640 standard chrome + taskbar). The existing `inari` window is removed from `capabilities/default.json` at end of Session 14.
Reason:   The two windows have incompatible specs. Reconfiguring `inari` to match the dock spec would break the current vanilla shell that depends on the standard-chrome geometry.
Impact:   Session 14's `window/dock.rs` creates the new label `dock`. Session 14 also updates `capabilities/default.json` to drop `inari` from the windows array (`["main", "dock", "inari-settings"]` if onboarding stays separate, or `["main", "dock", "settings"]` after Session 17).

## 2026-04-29 — Sesión 1
Decision: `src/fingerprint.rs` moves to `src/memory/fingerprint.rs` rather than staying as a top-level module.
Reason:   Session 12's procedural matcher is the primary call-site post-Session-10 (which deletes `inari_watcher.rs`). `memory/fingerprint.rs` keeps the call-graph local (`memory::procedural` calling `memory::fingerprint`).
Impact:   Session 11 does the move (since it touches `memory/` first). All imports change from `crate::fingerprint::compute_error_fingerprint` to `crate::memory::fingerprint::compute_error_fingerprint`. Wire-format must remain byte-identical to `web/lib/ai/fingerprint.ts` and `cli/src/mcp/fingerprint.rs` — a regression test asserts this.

## 2026-04-29 — Sesión 1
Decision: Each session owns the **destination move** of its existing-file refactor. No pre-emptive moves in Session 2.
Reason:   Sessions can run in parallel after Track 1 completes. If Session 2 pre-emptively moves files, parallel Sessions 5 + 7 + 11 would all start with stale paths. By having each session land its move at the end, conflict surface is minimized.
Impact:   Session 2 is allowed to create *empty* module skeletons (`pub mod cloud;`, `pub mod sensors;`, etc.) so future sessions just fill them in. No content moves yet.

## 2026-04-29 — Sesión 1
Decision: Heavy-data IPC rule is locked here: never serialize `Vec<f32>` embeddings, full ASTs, or > 10k-entry lists, or > 100KB diffs through `tauri::invoke`/`tauri::emit`. Heavy data goes via the local MCP HTTP transport on `127.0.0.1:9876` (Session 7).
Reason:   Tauri IPC serializes through a single JSON channel; large payloads block the webview thread and inflate memory in dev. Spec recap performance budget (<120MB RAM idle) cannot survive a single 384-dim × 50k-symbol vector dump.
Impact:   Every PR is reviewed against this rule. Exceptions require an `INARI_LIVE_DECISIONS.md` entry. Frontend uses MCP HTTP for codebase search, AST traversal, large-diff fetching.

## 2026-04-29 — Sesión 1
Decision: Drop `src/onboarding.rs`'s frontend usage at end of Session 17, but leave the Tauri commands reachable until then.
Reason:   Session 17 ships a multi-step onboarding (drag-repo → power-ups → ready). The current 1-step "pick a folder" onboarding is functional and unblocks dogfood through Sessions 2-16. Removing it pre-Session-17 would force Sessions 2-16 to ship without any onboarding flow at all.
Impact:   `ipc/onboarding.rs` (renamed in Session 4) ships unchanged. Session 17 deletes the file at end of session after the React-side replacement is verified.
