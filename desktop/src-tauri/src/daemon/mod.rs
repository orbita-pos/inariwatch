//! Daemon core: event bus + lifecycle + shared state.
//!
//! This module is the ambient, tray-resident process that owns all
//! cross-sensor coordination. Sensors (Sessions 5-10) publish events to
//! [`bus::EventBus`]; the lifecycle task (this module) emits a
//! `Heartbeat` every 30s and handles graceful shutdown drain.
//!
//! Event taxonomy starts intentionally tiny (`Heartbeat` + `Shutdown`).
//! Sensors append their own variants in their own session — the
//! `non_exhaustive` attribute means downstream `match` arms must keep a
//! `_ =>` fallback so future variants don't break the build.

pub mod bus;
pub mod lifecycle;
pub mod state;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Classification of a single filesystem change reported by the FS sensor.
///
/// Lives under `daemon` so all consumers (sensors, IPC bridge, indexer,
/// remediator) can pattern-match without an `sensors::*` import. The
/// debouncer-mini we use only emits coarse Any/AnyContinuous categories
/// — the watcher classifies into [`Created`/`Modified`/`Deleted`] by
/// stat-checking the path post-debounce. [`Renamed`] is reserved for a
/// future debouncer-full upgrade or platform-specific event paths
/// (FSEvents on macOS already gives us the rename pair; we just don't
/// surface it in v0.1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FsChangeKind {
    Created,
    Modified,
    Deleted,
    Renamed { from: PathBuf },
}

/// Classification of a `memory.md` review event published by the
/// declarative-memory watcher (Session 11).
///
/// `Initial` — repo was just opened and Inari wrote the template
/// `memory.md` for the first time; the user should review the seed.
/// `Append`  — Inari wants to add a NEW heading-level section to an
/// existing `memory.md` (no existing section is mutated).
/// `Replace` — Inari wants to replace the body of an EXISTING
/// non-`[pinned]` section. `[pinned]` sections are immutable and never
/// trigger `Replace`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryKind {
    Initial,
    Append,
    Replace,
}

/// Which git lifecycle event was observed by Sensor 4 (Session 8).
///
/// Lives under `daemon` for the same reason as [`FsChangeKind`] — every
/// downstream consumer (memory layer, dock UI, indexer hint) can pattern
/// match without crossing a `sensors::*` boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GitEventKind {
    PreCommit,
    PostCommit,
    PrePush,
    PostMerge,
}

/// Class of substrate replay divergence reported by Sensor 6 (Sesión
/// 10). Mirrors `web/lib/ai/substrate-replay.ts` so the Rust + web
/// consumers can share dock UI shapes without translation. The variants
/// are a closed set on purpose — adding a new class requires a coupled
/// update to the dock copy + the AI replay analyst prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DivergenceKind {
    /// Recorded I/O (HTTP body, DB query, file op) differs from the
    /// replayed I/O. Always graded `Medium` or `High`.
    IoMismatch,
    /// Replay finished but the wall-clock duration differs by enough
    /// that downstream timing assertions (timeouts, debounce windows)
    /// could fail in production. Graded `Low` by default.
    Timing,
    /// Replay process exited with a different code than the recording.
    /// Graded `High` regardless of the exit code value.
    ExitCode,
}

/// Severity bucket for a [`DivergenceSummary`]. The dock surfaces this
/// as a colour band; the security gate (Sesión 20 Gate 6) treats `High`
/// as a hard fail and `Medium` as a soft warning.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DivergenceSeverity {
    Low,
    Medium,
    High,
}

/// Summary of a substrate replay divergence. Crucially does NOT carry
/// the user's source content or recorded payloads — the full payload is
/// persisted to `.inari/replays/<id>.json` for the dock (Sesión 17) to
/// load on demand. Only metadata travels on the bus so a downstream
/// subscriber that logs every event can't accidentally exfiltrate
/// recorded body data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DivergenceSummary {
    pub kind:            DivergenceKind,
    /// Module name (Node-style) the divergence was detected in. NEVER
    /// a filesystem path — keeps absolute paths off the bus.
    pub affected_module: String,
    pub severity:        DivergenceSeverity,
}

/// Cross-sensor event broadcast on [`bus::EventBus`].
///
/// Initial variants are minimal by design — each sensor session adds its
/// own variant when it lands. `#[non_exhaustive]` forces consumers to
/// handle the unknown-variant case so adding events is non-breaking.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[non_exhaustive]
pub enum DaemonEvent {
    /// Liveness signal emitted every 30s by the lifecycle task.
    Heartbeat { uptime_secs: u64 },
    /// Cooperative shutdown signal. Sensors drain remaining work and exit.
    Shutdown,
    /// Initial walk of an attached repo finished. `file_count` excludes
    /// directories and entries the walker filtered via `.gitignore` /
    /// `.git/info/exclude` / global git ignore. `duration_ms` is wall
    /// clock for the walk on the rayon thread pool.
    RepoIndexed {
        repo_id:     String,
        file_count:  u64,
        duration_ms: u64,
    },
    /// A debounced filesystem change. `path` is canonicalized relative
    /// to the repo when the file still exists, otherwise it's whatever
    /// path the kernel gave us at delete-time (notify reports the path
    /// that was being watched).
    ///
    /// Field-level `#[serde(rename = "change")]` on `kind` is a serde
    /// requirement: the outer enum is internally-tagged on `"kind"`,
    /// and serde rejects a variant field of the same name. The Rust
    /// API keeps `kind` per Session-5 spec; the JSON wire field is
    /// `change` instead — see `INARI_LIVE_DECISIONS.md` 2026-04-29
    /// "Sesión 5 — DaemonEvent::FsChange field rename".
    FsChange {
        repo_id: String,
        path:    String,
        #[serde(rename = "change")]
        kind:    FsChangeKind,
    },
    /// Non-fatal sensor degradation. Carries a sensor name + a
    /// human-readable hint. Surfaced in the dock as a Nivel 1 toast,
    /// never crashes. Today emitted by the FS sensor on inotify
    /// limit hits (Linux ENOSPC / EMFILE).
    SensorWarning {
        sensor:  String,
        message: String,
    },
    /// Manual reindex request. Published by the MCP `reindex_codebase`
    /// tool (Session 7) and consumed by the indexer (Session 6). The
    /// indexer re-walks the repo, re-parses, and re-embeds — see
    /// `crate::indexer::spawn_indexer` for the consumer side.
    ReindexRequested { repo_id: String },
    /// Indexer finished a batch (initial bootstrap or manual reindex).
    /// `symbol_count` is the number of `code_symbols` rows that exist
    /// for this repo after the run; `duration_ms` is wall-clock for
    /// the entire bootstrap (including parse + embed + DB upsert).
    SymbolsIndexed {
        repo_id:      String,
        symbol_count: u64,
        duration_ms:  u64,
    },
    /// Declarative-memory watcher (Session 11) flagged a `memory.md`
    /// proposal for human review. Carries the repo and a [`MemoryKind`]
    /// classifying the change (initial template / append / replace).
    /// The dock surfaces this as a non-blocking review prompt; nothing
    /// hits disk until the user calls `commit_memory_md`.
    ///
    /// Same `#[serde(rename = ...)]` workaround `FsChange` uses: the
    /// outer enum is internally-tagged on `"kind"`, and serde rejects a
    /// variant field of the same name. The Rust field stays `kind` per
    /// the Session-11 prompt; the JSON wire field is `review_kind`.
    MemoryReviewRequested {
        repo_id: String,
        #[serde(rename = "review_kind")]
        kind:    MemoryKind,
    },
    /// User accepted a `memory.md` proposal in the dock. Carries the
    /// approved content; the watcher persists a new version row.
    MemoryReviewApproved {
        repo_id: String,
        content: String,
    },
    /// Git hook fired (Session 8). `pre_push` is the only synchronous
    /// kind — it consumes a verdict from the local gate runner before
    /// the push proceeds. The other three are fire-and-forget and
    /// surface in the dock + memory layers as commit/merge milestones.
    ///
    /// Field name `kind` would clash with the internally-tagged outer
    /// enum, so the wire field is `event` (matching the Sesión-5
    /// `change` precedent on [`FsChange`]).
    GitEvent {
        #[serde(rename = "event")]
        kind:     GitEventKind,
        repo_id:  String,
        ref_name: String,
        sha:      String,
    },
    /// Shell command observed by Sensor 2 (Session 9). The hook script
    /// running in the user's shell (`zsh`/`bash`/`fish`) sends one
    /// JSON message per command over the per-platform local socket
    /// (`~/.inari/sock/shell.sock` on Unix, `\\.\pipe\inari-live-shell`
    /// on Windows). `session_id` is server-assigned per connection so
    /// downstream consumers can group events by shell session without
    /// trusting the script.
    ///
    /// The hook script SCRUBS env-var-shaped secrets (regex on
    /// `*KEY*`/`*SECRET*`/`*TOKEN*`/`*PASSWORD*`/`*PASSWD*`/`*PWD*`)
    /// BEFORE sending — see `desktop/src-tauri/resources/shell/README.md`.
    ShellEvent {
        session_id:  String,
        cmd:         String,
        cwd:         PathBuf,
        exit_code:   i32,
        duration_ms: u64,
        timestamp:   u64,
    },
    /// Substrate replay correlation result emitted by Sensor 6
    /// (Sesión 10). Published whenever an `FsChange::Modified` of a
    /// source file is reconciled against the most-recent recording in
    /// `.inari/recordings/<repo>/`. `matched=true` means the replay
    /// drained without behavioural divergence; `matched=false` carries
    /// a [`DivergenceSummary`] describing the class + severity.
    ///
    /// Same `#[serde(rename = ...)]` workaround [`FsChange`] +
    /// [`MemoryReviewRequested`] use: `match` is a Rust keyword, so
    /// the Rust API uses `matched` while the JSON wire field is
    /// `match` per the Sesión-10 spec.
    ///
    /// Privacy: the variant carries the recording id (UUID v4) and the
    /// optional summary metadata only. The full divergence payload
    /// lives in `.inari/replays/<id>.json` on disk for the dock UI
    /// (Sesión 17) to read on demand — recorded bodies, source
    /// snippets, and raw timings never travel on the bus.
    ReplayResult {
        repo_id:      String,
        recording_id: String,
        #[serde(rename = "match")]
        matched:      bool,
        divergence:   Option<DivergenceSummary>,
    },
    /// Sesión 18 — one streamed delta from an OpenAI chat completion.
    /// `session_id` is the chat-message id the original caller passed
    /// in (one assistant message = one session). The `start_chat_stream`
    /// IPC that historically dispatched these was deleted in Phase 4.6
    /// of the pure-slash refactor; the variant is preserved for the
    /// `local_ai_infer` IPC (which uses its own `local-ai-*` events
    /// rather than this bus path — kept here so a future structured-
    /// stream slash command can reuse the wire format). `finish_reason`
    /// is `Some(_)` only on the closing event (`stop` / `length` /
    /// `error` / etc.); intermediate chunks carry `None` and a non-
    /// empty `token`.
    ///
    /// Privacy: token strings ARE the user's question response, so the
    /// bus subscriber list is the trust boundary. The IPC events
    /// bridge already filters out logging for `daemon:event` payload
    /// bodies — the `tracing` calls in `streaming.rs` only log the
    /// session id + finish_reason, never the deltas themselves.
    ChatTokenStream {
        session_id:    String,
        token:         String,
        finish_reason: Option<String>,
    },
    /// S6 — assembled tool call emitted by the LLM during a chat
    /// stream. Published by `streaming.rs::stream_to_bus` once a
    /// `tool_call_delta` cluster has finished accumulating (the OpenAI
    /// adapter delivers the `index`-keyed slices; the streamer joins
    /// the `arguments` JSON string and forwards one event per call).
    ///
    /// `session_id` mirrors the chat-message id (same shape as
    /// `ChatTokenStream`), so the dock filters by the message it
    /// dispatched the IPC with. The frontend listener invokes
    /// `desktop_tool_invoke` against the local registry.
    ///
    /// Privacy: the `arguments` JSON is whatever the model passed —
    /// often a path or url; bus subscribers are the trust boundary.
    /// Same `tracing` posture as `ChatTokenStream`.
    ChatToolCall {
        session_id:   String,
        tool_call_id: String,
        name:         String,
        arguments:    String,
    },
    /// Sesión 19 — a remediation pipeline started for a repo. `mode`
    /// is `"local"` (single-shot AI on the dock) or `"cloud"`
    /// (cloud-proxied agentic). Persisted to the `events` table for
    /// audit trail; the dock subscribes to render the spinner / mode-3
    /// card.
    RemediationStarted {
        session_id: String,
        repo_id:    String,
        mode:       String,
    },
    /// Sesión 19 — progress signal from the remediation runner. NOT
    /// persisted (treated like `ChatTokenStream` chatter — see episodic
    /// policy). The dock surfaces these as transient stage labels in
    /// the diff viewer.
    RemediationProgress {
        session_id: String,
        stage:      String,
        message:    String,
    },
    /// Sesión 19 — terminal signal for a remediation session. `success`
    /// is true when the cloud path or local apply completed cleanly;
    /// `summary` carries a one-line user-facing message ("PR #1234
    /// created", "Fix discarded", "Apply failed: <reason>"). Persisted
    /// to `events` so future remediation runs can answer "did this
    /// fingerprint already get a fix attempt?".
    RemediationCompleted {
        session_id: String,
        success:    bool,
        summary:    String,
    },
    /// Sesión 19 — the user explicitly rejected a draft fix. Persisted
    /// alongside `RemediationStarted` for the audit trail. `reason`
    /// is the optional textarea content from the dock reject dialog.
    FixRejected {
        session_id: String,
        reason:     Option<String>,
    },
    /// Sesión 20 — pre-push gate runner spawned for a `pre_push`
    /// hook event. `gates` lists the gate names the runner will
    /// evaluate in parallel ("self_review" / "substrate_simulate" /
    /// "security_scan" — the local subset that isn't already evaluated
    /// inline by `sensors::git::gate::evaluate`). Persisted to the
    /// `events` table as audit trail (gates are security-relevant).
    GateRunStarted {
        run_id:  String,
        repo_id: String,
        gates:   Vec<String>,
    },
    /// Sesión 20 — per-gate progress tick from the runner. NOT
    /// persisted (chatter, same posture as `ChatTokenStream` /
    /// `RemediationProgress`); the dock subscribes to drive Mode 5
    /// transitions but the audit trail relies on the start / completed
    /// pair instead. `state` ∈ {"running", "passed", "failed"};
    /// `reason` is `Some(_)` only on the failure tick.
    GateProgress {
        run_id:     String,
        gate:       String,
        state:      String,
        reason:     Option<String>,
        latency_ms: u64,
    },
    /// Sesión 20 — terminal verdict for a runner invocation. `allowed`
    /// is the boolean the HTTP handler returns to the hook script;
    /// `blocking_gates` enumerates the gate names that voted false
    /// (empty when allowed). Persisted to the `events` table.
    GateRunCompleted {
        run_id:           String,
        allowed:          bool,
        blocking_gates:   Vec<String>,
        total_latency_ms: u64,
    },
    /// Sesión 20 — the user invoked the bypass affordance (HTTP
    /// header `X-Inari-Bypass: 1` on the pre_push request, or the
    /// `request_bypass` IPC after a verdict landed). `reason` is the
    /// optional free-text label from the IPC path; the header path
    /// emits `None`. Persisted to audit who explicitly chose to push
    /// against a blocking verdict.
    GateBypassUsed {
        run_id:  String,
        repo_id: String,
        reason:  Option<String>,
    },
    /// Sesión 12 — procedural learner observed a `RemediationCompleted`
    /// success (or a hit on an existing pattern) and either created or
    /// strengthened a pattern row in `.inari/patterns.json`. Persisted
    /// to the `events` table as audit trail (same posture as
    /// `RemediationCompleted` — infinite TTL, "what did the system
    /// learn from this fix?").
    ///
    /// `kind` is the wire string for [`crate::memory::procedural::PatternKind`]
    /// (`"auto-detected"` or `"anti-pattern"`). Carrying it as a plain
    /// `String` keeps the daemon module from depending on the
    /// procedural module (no cyclic types).
    ///
    /// Same `#[serde(rename = ...)]` workaround the rest of the
    /// internally-tagged variants use: the outer enum is tagged on
    /// `"kind"`, and serde rejects a variant field of the same name.
    /// The Rust API keeps `kind`; the JSON wire field is
    /// `pattern_kind`.
    PatternLearned {
        repo_id:       String,
        fingerprint:   String,
        #[serde(rename = "pattern_kind")]
        kind:          String,
        success_count: u32,
    },
    /// Sesión 12 — procedural learner downgraded a previously
    /// `auto-detected` pattern to `anti-pattern` because failures
    /// outweighed successes (`reason = "failure_majority"`) or because
    /// a regression was forced (`reason = "regression_forced"`,
    /// reserved for the future regression-detector emitter — see the
    /// DECISIONS entry "Sesión 12 — RegressionDetected variant
    /// deferred"). Persisted to the `events` table — anti-pattern
    /// demotions are security-relevant ("why did Inari stop suggesting
    /// fix X?" answers from this row).
    PatternDemoted {
        repo_id:       String,
        fingerprint:   String,
        prior_success: u32,
        new_failure:   u32,
        reason:        String,
    },
}

pub use bus::EventBus;
pub use lifecycle::{start_daemon, DaemonHandle};
pub use state::{DaemonStatus, SharedDaemonState};

// `MemoryKind` is part of the public daemon event taxonomy — re-export at
// crate root so consumers (Session 11 watcher, IPC commands, future dock
// UI) can pattern-match without reaching into the inner module.
