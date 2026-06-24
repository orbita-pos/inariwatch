# Inari Live — Module Architecture (post-Session 1 audit)

**Audit date:** 2026-04-29
**Branch:** `feat/inari-live-track1-session1-audit`
**Status:** read-only audit — no code changes this session
**Anchors this doc against:** `radar/INARI_LIVE_HANDOFF.md` (master plan, Sessions 1–26 + A/B/C)

This document is the agreed module split that all subsequent sessions implement against. It is the **single source of truth** for "where does this code go" until a future session amends it via `INARI_LIVE_DECISIONS.md`.

---

## Existing scaffold inventory

Each row reflects a read of the file at audit time. **Verdict** is one of: KEEP (move to a new module under the target structure as-is), KEEP+SPLIT (logic survives but is fanned out across multiple new modules), RENAME (kept but renamed), DELETE (no surviving callers post-migration), DEFER (decision postponed to a later session that has more context).

| File | LoC | What it does | External deps | State | Verdict | Target |
|------|----:|--------------|---------------|-------|---------|--------|
| `src/main.rs` | 5 | Trivial Tauri entry — calls `inariwatch_desktop_lib::run()` | none | Complete | **KEEP** | `src/main.rs` (unchanged) |
| `src/lib.rs` | 379 | Tauri builder + window setup + tray menu + alert poller + spawns watcher + ingest. Wires every command handler. | `tauri`, `reqwest`, `dirs`, plugins (notification, autostart, dialog, updater) | Complete (works) | **KEEP+SPLIT** | becomes thin glue: tray/window → `window/`, alert poller → `cloud/alert_poller.rs`, command registry stays here |
| `src/autofix.rs` | 238 | `desktop_autofix_start` Tauri cmd + SSE consumer streaming `/api/desktop/autofix/{start,stream/:id}` events into webview. Cloud-proxy autofix surface. | `reqwest`, `serde_json`, `futures-util`, `dirs` | Complete | **KEEP** + RENAME | `ai/remediate/cloud_proxy.rs` (Session 19's "cloud agentic proxied" path is exactly this) |
| `src/connect.rs` | 304 | `desktop_connect_project` / disconnect / status. Spawns user's `npm run <script>` with `NODE_OPTIONS=--import file://<bundled-capture>/auto.js` + `INARIWATCH_DSN=http://127.0.0.1:9111/ingest`. Detects framework + dev script from package.json. | `tokio::process`, `reqwest`, `serde_json`, `dirs` | Complete | **KEEP** + RENAME | `cli/run.rs` (Session A formalizes `inari run` — current code IS the prototype). Tauri-command wrappers stay reachable via `ipc/connect.rs`. |
| `src/desktop_auth.rs` | 280 | Device flow Tauri cmds (`start` / `poll` / `status`). Persists `dashboard_url` + `dashboard_token` to `~/.config/inari/desktop.toml`. Opens browser via platform shell. | `reqwest`, `dirs`, `tokio` | Complete | **KEEP** + RENAME | `cloud/auth.rs` (new `cloud/` module — see § *Open architectural decision: `cloud/` module*) |
| `src/fingerprint.rs` | 73 | SHA-256 fingerprint v1, byte-identical to `web/lib/ai/fingerprint.ts` and `cli/src/mcp/fingerprint.rs`. 9 regexes for normalization. | `regex`, `sha2`, `once_cell` | Complete | **KEEP** + RENAME | `memory/fingerprint.rs` (Session 12's procedural matcher hashes errors here — same call-site, same module) |
| `src/inari_watcher.rs` | 910 | The big one. (a) `notify` recursive watch with paused tray toggle + idle/curious/calculating/dancing/worried/scared state machine. (b) `/v2/replay` POST with debounce + single-in-flight + 503 backoff + dashboard auto-discovery (`/api/desktop/recordings/latest`). (c) Community pattern lookup (`/api/desktop/patterns/match`). (d) Bug-saved POST on rising edge. Reads desktop.toml. | `notify`, `reqwest`, `tokio`, `serde`, `dirs`, `crate::fingerprint` | Complete (production-shaped) | **KEEP+SPLIT** | Three new homes: file-watch loop → `sensors/fs/watcher.rs` (Session 5 rebuilds with `notify-debouncer-mini` + `ignore` walker, but current state machine is reference impl); replay dispatch + recording discovery + saves POST → `sensors/substrate/wrapper.rs` (Session 10 inherits this code); community match lookup → `memory/procedural/matcher.rs` (Session 12). Actual deletion happens at end of Session 10. |
| `src/local_ingest.rs` | 187 | Hand-rolled HTTP server on `127.0.0.1:9111`. Accepts `POST /ingest` + CORS preflight + `GET /health`. Forwards bodies to webview as `inari:live-error` Tauri events. | `tokio::net`, `serde_json` | Complete | **KEEP** + RENAME | `sensors/substrate/local_ingest.rs` (this is the **receive end** of the wrapped dev server from `connect.rs` — same data flow, different process boundary). May later move to `daemon/ingest.rs` if it grows. |
| `src/onboarding.rs` | 133 | Three Tauri cmds: `desktop_first_run_status`, `desktop_pick_watch_dir`, `desktop_save_watch_dir`. TOML-backed. | `tauri-plugin-dialog`, `dirs` | Complete | **KEEP** + RENAME | `ipc/onboarding.rs`. Note: Session 17's onboarding flow is multi-step (drag repo → power-ups → ready) and will SUPERSEDE this 1-step "pick a folder" version — these commands stay during the transition, but the frontend stops calling them post-Session 17. **DEFER deletion to Session 17.** |
| `src/saves.rs` | 96 | `desktop_get_saves_summary` Tauri cmd. GET `/api/desktop/saves`. Returns `{total_saves, total_value_saved_usd_cents, total_value_saved_usd, connected}`. | `reqwest`, `dirs` | Complete | **KEEP** + RENAME | `cloud/saves.rs` |
| `src/settings.rs` | 247 | Five Tauri cmds: `get_settings`/`save_settings`/`logout`/`open_settings`/`app_version`. TOML-backed BTreeMap with safe-display redaction (tokens become booleans). Owns the `inari-settings` window. | `tauri`, `dirs`, `serde` | Complete | **KEEP+SPLIT** | Settings store (read/write TOML, redact tokens) → `store/settings.rs` (until Session 3's SQLite migration absorbs it); settings window opener → `window/settings.rs`; Tauri command surface → `ipc/settings.rs` |
| `Cargo.toml` | 33 | Tauri 2 + plugins, tokio, reqwest, notify, sha2, regex, once_cell, futures-util | n/a | Working | **KEEP** | Sessions 2–10 each add their own deps incrementally per spec |
| `tauri.conf.json` | 45 | Tauri 2 config. **Frontend is `../dist`** (static HTML/JS, NOT React/Vite yet). Updater plugin endpoint set to `app.inariwatch.com/api/desktop/updater`. Bundle resource `../dist/sdk-bundle/**`. | n/a | Visual prototype | **KEEP** + EVOLVE | Session 14 rewrites the `frontendDist` to `../dist-vite` (or similar) once React+Vite shell lands. Updater pubkey is empty — Session 22 fills it. |
| `capabilities/default.json` | 17 | Permissions for windows `main`, `inari`, `inari-settings`. Allows core, notification, dialog. | n/a | Minimal | **KEEP** + EVOLVE | Session 4 adds shell-permission scope for IPC; Session 14 adds `core:webview-window:allow-create` for the dock; capabilities split per-window once we have `dock` vs `main` vs `settings` distinct surfaces |
| `package.json` | 17 | Tiny: `@tauri-apps/cli` + `bundle-sdk` script. **No React/Vite/Tailwind yet.** | n/a | Pre-Session-14 stub | **KEEP** + EVOLVE | Session 14 adds React 19, Vite, Tailwind v4, Radix, Framer Motion, etc. per spec recap |
| `dist/inari/index.html`, `app.js`, `styles.css`, `settings.html`, `settings.js`, `settings.css`, `sounds.js` | ~85 KB total | Visual MVP shell — vanilla HTML/JS dock with onboarding overlay + 5 views (Home/Stats/Replays/Project/Settings) + fox avatar + state pill + activity timeline. Subscribes to `inari:set-state`, `inari:saved`, `inari:live-error`, `autofix:event`, `inari:connect-status`. | none (vanilla) | Complete prototype | **KEEP-AS-PROTOTYPE → DELETE Session 14** | Lives at `desktop/dist/inari/`. Session 14 replaces with React+Vite build output. Until Session 14 lands, this stays as the active webview source so the current Tauri shell keeps running for dogfood. |
| `dist/inari/assets/inari-*.svg`, `*.mp4` | 6 SVGs + 4 mp4s + 1 loop | Recraft GPT Image + Vectorize fox states (sleeping/curious/calculating/dancing/worried/scared) + raw clips | none | Complete | **KEEP** | `desktop/src/assets/fox/` (post-Session-14 React tree) — Recraft IP retained, ~$12 sunk cost is preserved |
| `dist/inari/build-*.py`, `analyze-paths.py`, `process-videos.py`, `render-paths.mjs`, `test-animations.mjs`, `contact-sheet.html`, `debug.html`, `test-shots/`, `contact-sheet/` | n/a | Asset-generation scratchpad. Not runtime. | python, ffmpeg | Scratchpad | **DELETE** post-Session-14 | Move under `desktop/asset-pipeline/` if we want history; otherwise drop. **DEFER deletion** until assets are stable in the React tree. |

---

## Open architectural decision: introduce a `cloud/` module

The target structure in `INARI_LIVE_HANDOFF.md` enumerates `daemon/`, `sensors/`, `memory/`, `ai/`, `ipc/`, `store/`, `window/`, `gates/`, `updater/`, `telemetry/`, `cli/` — **but the existing scaffold has four files that do not fit cleanly into any of those**:

1. `desktop_auth.rs` — device flow against `app.inariwatch.com`
2. `lib.rs::start_alert_poller` — 60s polling of `/api/desktop/alerts`
3. `saves.rs` — `/api/desktop/saves` summary call
4. *(future)* connect-status broadcast, workspace metadata fetch, cloud-only feature detection

These are **cross-cutting workspace/cloud-API concerns** — neither sensor input, nor memory, nor AI, nor pure IPC. Forcing them under `ipc/` conflates HTTP-to-cloud with IPC-to-webview. Putting them under `ai/` is wrong (no AI work). Spreading them as siblings of `daemon/` is the cleanest fit.

**Proposal (decided in Session 1, recorded in `INARI_LIVE_DECISIONS.md`):** introduce `src/cloud/` alongside the spec-named modules, with submodules:

- `cloud/auth.rs` — device flow (replaces `desktop_auth.rs`)
- `cloud/alert_poller.rs` — alert polling loop (extracted from `lib.rs`)
- `cloud/saves.rs` — saves summary (replaces `saves.rs`)
- `cloud/api.rs` — shared `reqwest::Client` + `read_dashboard_creds()` helper (de-duplicate the 4 copies that exist today)

Spec compliance: this **does not violate** any spec recap constraint. It clarifies a layer the spec implicitly assumed lived in `daemon/` or `ipc/`. Sessions 18-23 reference `ai/`, `gates/`, `updater/`, `telemetry/` directly and are unaffected.

If the architect rejects `cloud/`, the fallback is to fold these files into `daemon/cloud/` — but that hides them inside the daemon scope, making them harder to test and reason about. `cloud/` as a peer module is the recommended choice.

---

## Module split (target structure)

```
src-tauri/src/
├── main.rs                      — entry (5 lines, KEEP unchanged)
├── lib.rs                       — Tauri Builder wiring + command registry (slimmed down)
│
├── daemon/                      — Session 2: event bus + lifecycle + state
│   ├── mod.rs
│   ├── bus.rs                   — flume broadcast, `DaemonEvent` enum
│   ├── lifecycle.rs             — start/shutdown, sensor drain, 5s grace
│   └── state.rs                 — daemon-wide read state (uptime, sensor count, repo count)
│
├── sensors/                     — input streams (one module per sensor)
│   ├── fs/                      — Session 5
│   │   ├── mod.rs
│   │   ├── watcher.rs           — `notify-debouncer-mini` recursive watch (REPLACES inari_watcher.rs L1-220)
│   │   ├── walker.rs            — `ignore::WalkBuilder` initial walk
│   │   └── debouncer.rs         — 200ms debounce + classify
│   ├── mcp/                     — Session 7
│   │   ├── mod.rs
│   │   ├── server.rs            — JSON-RPC 2.0 dispatch
│   │   ├── tools.rs             — 25 tool wrappers (port from web/app/api/mcp/tools/)
│   │   ├── transport_stdio.rs   — stdio sidecar binary `inari-mcp-stdio`
│   │   └── transport_http.rs    — axum on `127.0.0.1:9876`
│   ├── shell/                   — Session 9
│   │   ├── mod.rs
│   │   ├── socket.rs            — interprocess Unix socket / Win named pipe
│   │   └── installer.rs         — zsh/bash/fish install + uninstall
│   ├── git/                     — Session 8
│   │   ├── mod.rs
│   │   ├── hooks.rs             — pre-commit/post-commit/pre-push receivers
│   │   └── installer.rs         — write hooks + backup pre-existing
│   ├── proxy/                   — DEFERRED to v0.2 (NOT v0.1)
│   └── substrate/               — Session 10 (+ existing inari_watcher.rs replay logic)
│       ├── mod.rs
│       ├── wrapper.rs           — wraps user's `npm run dev` with `--import @inariwatch/capture/auto` + `--import @inariwatch/substrate-agent/auto` (extends connect.rs logic)
│       ├── replay_client.rs     — `/v2/replay` POST + debounce + 503 backoff (PORTED from inari_watcher.rs L460-680)
│       ├── recording_discovery.rs — dashboard auto-discovery + cache (PORTED from inari_watcher.rs L370-440)
│       └── local_ingest.rs      — `127.0.0.1:9111` capture receiver (PORTED from local_ingest.rs)
│
├── memory/                      — 4-layer memory (Sessions 11-13)
│   ├── mod.rs
│   ├── fingerprint.rs           — error fingerprint v1 (RENAMED from src/fingerprint.rs)
│   ├── semantic/                — Session 13: fastembed + sqlite-vec retrieval
│   ├── episodic/                — Session 13: events table + retention
│   ├── declarative/             — Session 11: memory.md + memory.local.md + precedence
│   └── procedural/              — Session 12: patterns.json + matcher (community lookup PORTED from inari_watcher.rs L700-740)
│
├── indexer/                     — Session 6 (tree-sitter + fastembed)
│   ├── mod.rs
│   ├── parser.rs
│   ├── embeddings.rs
│   └── batcher.rs
│   (Note: spec calls this a top-level peer of `sensors/`, not under `memory/` — kept here per spec.)
│
├── ai/                          — Sessions 18-19
│   ├── mod.rs
│   ├── openai.rs                — multi-method client
│   ├── streaming.rs             — SSE parser → bus events
│   ├── budget.rs                — per-day spend cap + downgrade policy
│   ├── prompts.rs               — ports from web/lib/ai/prompts.ts
│   └── remediate/               — Session 19
│       ├── mod.rs
│       ├── single_shot.rs       — local diff generation
│       ├── cloud_proxy.rs       — RENAMED from src/autofix.rs
│       └── orchestrator.rs      — local-vs-cloud routing + apply diff
│
├── ipc/                         — Tauri command surface (Session 4)
│   ├── mod.rs
│   ├── commands.rs              — daemon_status / list_repos / open_repo / close_repo / get_logs (Session 4)
│   ├── events.rs                — typed event emitter wrappers
│   ├── connect.rs               — RENAMED from src/connect.rs (Tauri command shells; impl moves to cli/run.rs)
│   ├── onboarding.rs            — RENAMED from src/onboarding.rs (Session 1 keep, Session 17 supersedes frontend)
│   ├── settings.rs              — Tauri-command shells RENAMED from src/settings.rs (impl in store/settings.rs + window/settings.rs)
│   └── auth.rs                  — Tauri-command shells RENAMED from src/desktop_auth.rs (impl in cloud/auth.rs)
│
├── store/                       — Session 3
│   ├── mod.rs                   — rusqlite + r2d2 pool, WAL mode
│   ├── migrations/              — 0001_initial.sql, 0002_embeddings.sql, 0003_memory.sql
│   ├── queries.rs
│   └── settings.rs              — TOML settings store TODAY, migrates to SQLite during Session 3
│
├── window/                      — Session 14 (dock + main + settings + onboarding chrome)
│   ├── mod.rs
│   ├── dock.rs                  — 720×480 transparent vibrancy Accessory window (Session 14 creates; replaces existing inari window)
│   ├── main.rs                  — 1280×820 main window (PORTED from lib.rs::setup_window)
│   ├── tray.rs                  — tray icon + menu (PORTED from lib.rs::setup_tray)
│   ├── settings.rs              — settings window opener (PORTED from settings.rs::desktop_open_settings)
│   └── onboarding.rs            — Session 17 multi-step onboarding window
│
├── gates/                       — Session 20
│   ├── mod.rs
│   ├── runner.rs                — parallel gate executor (tokio::join!)
│   └── local_subset.rs          — gates 1, 4, 5, 6, 9 (the web-infra-free subset)
│
├── updater/                     — Session 22
│   ├── mod.rs                   — tauri-plugin-updater glue + Ed25519 verification + metered network detection
│
├── telemetry/                   — Session 23
│   ├── mod.rs                   — anonymized event reporter (default ON, opt-out)
│
├── cloud/                       — NEW MODULE (Session 1 architectural decision)
│   ├── mod.rs
│   ├── api.rs                   — shared http client + creds reader (deduplicate 4 copies)
│   ├── auth.rs                  — device flow IMPL (RENAMED from desktop_auth.rs)
│   ├── alert_poller.rs          — alert polling loop (EXTRACTED from lib.rs::start_alert_poller)
│   └── saves.rs                 — RENAMED from src/saves.rs
│
└── cli/                         — Session A (`inari run` subcommand)
    ├── mod.rs
    └── run.rs                   — `inari run <cmd>` IMPL (RENAMED+EXTENDED from src/connect.rs)
```

Symbols used:
- **PORTED** = code physically moved + namespace renamed, no behavior change.
- **EXTRACTED** = function/block lifted out of a larger file into its own module.
- **RENAMED** = file path changes; code largely intact.
- **REPLACES** = the new code obsoletes the old; the old gets deleted at the end of the named session.

---

## Migration plan (concrete moves for Session 2 to start with)

Session 2 is the FIRST session that touches code post-audit. It is allowed to land **only** the moves marked **(immediate)** below — the rest are owned by their named sessions and the file-deletes must happen at the END of those sessions, not before, to avoid breaking the working build during long sessions.

### Immediate (Session 2 itself)

Session 2's primary work is the daemon — `daemon/{bus,lifecycle,state}.rs` + `Cargo.toml` deps (`flume`, `tracing`, `tracing-subscriber`). The audit-driven moves Session 2 may do as cleanup *only if it has slack time*:

- **Create empty module skeletons** with `pub mod` declarations:
  - `src/daemon/mod.rs` (the session's main work)
  - `src/cloud/mod.rs` (empty, ready for Session N to fill)
  - `src/sensors/mod.rs` (empty)
  - `src/memory/mod.rs` (empty)
  - `src/ai/mod.rs` (empty)
  - `src/ipc/mod.rs` (empty)
  - `src/store/mod.rs` (empty — Session 3 fills)
  - `src/window/mod.rs` (empty)
  - `src/gates/mod.rs` (empty)
  - `src/updater/mod.rs` (empty)
  - `src/telemetry/mod.rs` (empty)
  - `src/cli/mod.rs` (empty)
- **Update `lib.rs`** to declare these new modules (`mod daemon; mod cloud; …`) so subsequent sessions just fill them in, never re-touch the wiring.
- **Do NOT move existing files yet.** Each existing-file rename happens in the session that owns the rename's destination (rationale: minimizes merge conflicts when sessions run in parallel per the parallelization windows).

### Per-session moves (each session does its own at end-of-session):

| Session | File moves at end of session |
|---------|------------------------------|
| **2** | Create empty module skeletons (above). No file moves. |
| **3** | Migrate `settings.rs` TOML store → `store/settings.rs` (SQLite-backed). Old TOML reader stays for backward compat 1 release. |
| **4** | `desktop_auth.rs` → `ipc/auth.rs` (command shells) + `cloud/auth.rs` (impl). `connect.rs` Tauri cmds → `ipc/connect.rs` (shells); impl stays in `connect.rs` until Session A. `saves.rs` → `cloud/saves.rs`. `onboarding.rs` → `ipc/onboarding.rs`. Extract `lib.rs::start_alert_poller` → `cloud/alert_poller.rs`. |
| **5** | Create `sensors/fs/{mod,watcher,walker,debouncer}.rs`. Old `inari_watcher.rs` STAYS active until Session 10 — do NOT delete in Session 5 (the replay code is still live). |
| **6** | Create `indexer/{mod,parser,embeddings,batcher}.rs`. |
| **7** | Create `sensors/mcp/{mod,server,tools,transport_stdio,transport_http}.rs`. |
| **8** | Create `sensors/git/{mod,hooks,installer}.rs`. |
| **9** | Create `sensors/shell/{mod,socket,installer}.rs`. |
| **10** | Create `sensors/substrate/{mod,wrapper,replay_client,recording_discovery,local_ingest}.rs`. **Port** the `/v2/replay` + recording discovery + saves rising-edge logic from `inari_watcher.rs`. **Port** `local_ingest.rs` content. **Delete** `src/inari_watcher.rs` and `src/local_ingest.rs` once parity tests pass. |
| **11** | Create `memory/declarative/`. Move `src/fingerprint.rs` → `src/memory/fingerprint.rs`. Update all imports (`crate::fingerprint::compute_error_fingerprint` → `crate::memory::fingerprint::compute_error_fingerprint`). |
| **12** | Create `memory/procedural/`. Port community-pattern lookup from `inari_watcher.rs` (already deleted in S10 — port from git history). |
| **13** | Create `memory/{semantic,episodic}` + `memory/retention.rs`. |
| **14** | Create `window/{mod,dock,main,tray,settings,onboarding}.rs`. Move `lib.rs::setup_window` + `setup_tray` + `open_inari_window` → `window/`. **Replace** `desktop/dist/inari/` HTML/JS shell with React+Vite build at `desktop/src/`. Delete old `dist/inari/*.html|*.js|*.css`, keep `dist/inari/assets/`. |
| **17** | Create `screens/{Onboarding,Settings,MainWindow}.tsx` (frontend). Backend `onboarding.rs` Tauri cmds get a *deprecation flag* — kept reachable but unused by new frontend. |
| **18** | Create `ai/{openai,streaming,budget,prompts}.rs`. |
| **19** | Create `ai/remediate/{single_shot,cloud_proxy,orchestrator}.rs`. **Move** `src/autofix.rs` → `ai/remediate/cloud_proxy.rs`. Update imports. |
| **20** | Create `gates/{runner,local_subset}.rs`. |
| **21** | Create `desktop/scripts/sign-{mac,win,linux}.{sh,ps1}`. |
| **22** | Create `updater/mod.rs`. Wire `tauri.conf.json` updater pubkey. |
| **23** | Create `telemetry/mod.rs`. |
| **A** | Create `cli/{mod,run}.rs`. **Move** `src/connect.rs` impl into `cli/run.rs`; the Tauri command shells in `ipc/connect.rs` import from there. |

The principle: **each session owns its own move + delete**. No "hot potato" file passing between sessions. The audit verdicts above commit *destination*, not *timing*.

---

## Heavy-data IPC rule (locked here, enforced via review in every session)

Per Session 4's spec: never serialize through Tauri IPC any of the following:
- `Vec<f32>` embeddings (any length)
- Full ASTs from tree-sitter
- Lists with > 10,000 entries
- Recordings (`.bin` files), full diffs > 100KB

Frontend asks for IDs / paginated slices / counts. Backend serves heavy data via the local MCP HTTP transport (`127.0.0.1:9876`) where streaming + chunking are first-class.

This is a **review gate**, not just a guideline. Any PR that violates it must be rejected unless an explicit `INARI_LIVE_DECISIONS.md` entry approves the exception.

---

## Decisions taken in this session

These are the audit-derived decisions appended to `INARI_LIVE_DECISIONS.md`:

1. **`cloud/` module is introduced** as a peer of `daemon/`, `sensors/`, `memory/`, `ai/`, `ipc/`, `store/`, `window/`, `gates/`, `updater/`, `telemetry/`, `cli/`. Hosts cross-cutting cloud-API concerns (auth, alert polling, saves summary, shared http client). Not in original spec — added Session 1 to avoid forcing these files into ill-fitting modules.
2. **`indexer/` is a top-level peer** of `sensors/` and `memory/`, not nested under `memory/`. Spec lists it as `desktop/src-tauri/src/indexer/mod.rs` (Session 6) so this matches the spec exactly. Recorded here for clarity.
3. **`memory/fingerprint.rs` location**: the existing `src/fingerprint.rs` becomes `src/memory/fingerprint.rs` rather than a top-level `crate::fingerprint` module. Reason: Session 12's procedural matcher is the primary call-site. Today's `inari_watcher.rs` is the only other call-site and it is deleted in Session 10.
4. **`inari_watcher.rs` is split, not preserved**: file is deleted at end of Session 10 after its three concerns (FS watch / replay dispatch / community lookup) are ported to their final homes. Session 5 does NOT delete it — Session 5 only adds the new FS sensor alongside.
5. **`autofix.rs` is `cloud_proxy.rs`**: the existing autofix bridge is *exactly* the "cloud agentic proxied" path Session 19 specifies. Renamed verbatim, no rewrite. The `single_shot.rs` and `orchestrator.rs` files in Session 19 are net-new code.
6. **`connect.rs` is the prototype for `inari run`**: the existing zero-install dev-mode wrapper is the prototype for Session A's `inari run <cmd>`. Session 10's substrate wrapper EXTENDS it (adds `--import @inariwatch/substrate-agent/auto` next to capture's). The two share the `bundled-npm/` resolution logic.
7. **Existing visual prototype (`dist/inari/`) survives until Session 14**: vanilla-HTML dock keeps running on `tauri dev` so we can dogfood replay + autofix flows pre-React-shell. Session 14 swaps the `frontendDist` to the Vite build output and deletes the HTML shell (preserves the asset directory).
8. **Old onboarding flow stays during Sessions 2–16**: the existing 1-step "pick a folder" onboarding is functional and unblocking. Session 17's multi-step flow (drag-repo → power-ups → ready) supersedes it. The Tauri commands are kept reachable but unused after Session 17 — the deletion happens in Session 17, not in Sessions 2–4.

---

## Open questions deferred to a later session

None of these block any currently-planned session. They are tracked here so they don't get lost:

1. **Single-binary vs sidecar for the MCP stdio transport**: Session 7 spec says "spawned as child process" — but a sidecar binary `inari-mcp-stdio` is mentioned in the same paragraph. Decide in Session 7: does Tauri bundle a second binary in the .dmg/.msi, or does it spawn `--mcp-stdio` as a subcommand of the main binary? Likely the latter (smaller bundle, single signing path).
2. **`tauri-plugin-tray`** is mentioned in Session 2 spec, but Tauri 2 ships tray support via the `tray-icon` feature flag (already enabled in `Cargo.toml`). No separate plugin exists. Session 2 should use the built-in path; spec wording is stale.
3. **`tauri-plugin-global-shortcut`** is correct (separate plugin). Session 2 adds it.
4. **`window-vibrancy` crate for macOS dock**: not yet in Cargo.toml. Session 14 adds it. macOS-only — Linux/Windows fall back to a styled background.
5. **Replacement for `dirs` crate**: `dirs` is unmaintained per its repo. Replace with `directories` or `etcetera` — DEFERRED to Session 3 when the SQLite store moves to `app_local_data_dir`. Not blocking.
6. **Does the existing `inari` window get repurposed as Session 14's dock, or scrapped?**: scrapped — sizes (480×640 vs 720×480), decorations (on vs off), transparency (off vs on with vibrancy), activation policy differ. Session 14 creates a new window labeled `dock` and removes the old `inari` window from `capabilities/default.json`.
7. **Performance budget enforcement**: the spec recap says <800ms cold start, <120MB RAM idle, <60MB binary. There is no automated check in CI today. Session B should add a smoke test that asserts these (boot time via `tauri::App::run` instrumentation, RAM via OS-specific RSS read, binary size via stat).
8. **Source Serif 4 / Inter / JetBrains Mono offline bundling**: Session 14 ships fonts in `public/fonts/`. License files (SIL OFL) must ship alongside — flag for Session 14.

---

## Cross-references

- **Master plan:** `radar/INARI_LIVE_HANDOFF.md`
- **Decision log:** `radar/INARI_LIVE_DECISIONS.md` (created in this session)
- **Existing memory entry (Session 0):** `project_inari_live.md` in `~/.claude/projects/.../memory/`
- **Spec recap:** `INARI_LIVE_HANDOFF.md` § *Spec recap* — fixed constraints, do not relitigate
- **Open questions deferred globally:** `INARI_LIVE_HANDOFF.md` § *Open questions deferred (NOT blockers)*
