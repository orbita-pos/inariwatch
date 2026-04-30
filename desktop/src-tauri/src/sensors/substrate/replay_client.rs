//! Replay backend trait + the two production impls (local binary +
//! remote `/v2/replay` HTTP endpoint).
//!
//! Single-trait, two-impl design so the actor in
//! [`super::actor`] can be swapped at test-time with a closure-driven
//! mock without owning either binary or HTTP path. The trait is
//! intentionally **synchronous + blocking**: both production impls
//! shell out (subprocess or `reqwest::blocking`) and the actor wraps
//! a single `replay()` call inside `tokio::task::spawn_blocking` so
//! the bus-driver loop never sits on a child process or socket.
//!
//! ## Backend selection (Sesión 10 default policy)
//!
//! 1. **Local first** — if `substrate-v2-replay` resolves on PATH (the
//!    binary built in Sesión 16 / `Substrate/crates/replay-engine`),
//!    we exec it with `--recording <dir> --overlay <file> --json`
//!    and parse stdout. ~100ms cold for a small recording, no
//!    network dependency.
//! 2. **Remote fallback** — if the binary is missing AND the env vars
//!    `INARI_STAGING_URL` + `INARI_STAGING_TOKEN` are both set, we POST
//!    `{recording_id, source_overlay_path}` to `${URL}/v2/replay` with
//!    `Authorization: Bearer ${TOKEN}` and parse the response. The
//!    endpoint is the Sesión 17 RaaS sandbox; `502/503/timeout` is
//!    treated as "no signal" and the caller silently skips the event
//!    (the actor never publishes a partial verdict).
//! 3. **No backend available** — the actor logs `info!` once at spawn
//!    time and then sits inert. `FsChange` events still arrive but
//!    no `ReplayResult` is ever published. This keeps the sensor
//!    harmless on machines without the binary AND without the staging
//!    URL configured (e.g. clean installs that haven't opted into
//!    Replay-as-you-code yet — the toggle defaults off anyway).
//!
//! Spec rationale → `INARI_LIVE_DECISIONS.md` (Sesión 10 — backend
//! selection rationale + DivergenceSummary shape).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::daemon::{DivergenceKind, DivergenceSeverity, DivergenceSummary};

/// Result of a single replay invocation. The actor turns this into a
/// [`crate::daemon::DaemonEvent::ReplayResult`] verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayOutcome {
    pub matched:    bool,
    pub divergence: Option<DivergenceSummary>,
}

impl ReplayOutcome {
    /// Convenience constructor for "everything matched". Used by both
    /// production impls for the happy path AND by the test mock.
    pub fn matched() -> Self {
        Self { matched: true, divergence: None }
    }

    /// Convenience constructor for a divergence outcome. The caller
    /// supplies the metadata; this helper enforces `matched: false`.
    pub fn diverged(summary: DivergenceSummary) -> Self {
        Self { matched: false, divergence: Some(summary) }
    }
}

/// Synchronous + blocking replay primitive. Implementations MUST be
/// `Send + Sync` so the actor can keep a `Box<dyn ReplayBackend>` in a
/// long-lived task.
///
/// `recording_dir` points at `.inari/recordings/<id>/` on disk.
/// `source_overlay` is the modified file path the FS sensor reported;
/// implementations either copy it onto the recording's tree before
/// replaying (local) or upload its contents alongside the recording id
/// (remote). The trait does not prescribe — each impl decides.
pub trait ReplayBackend: Send + Sync {
    /// Run the replay. Implementations are responsible for their own
    /// timeouts and error reporting; on `Err`, the actor logs at
    /// `warn` and silently skips the event.
    fn replay(
        &self,
        recording_dir: &Path,
        source_overlay: &Path,
    ) -> std::io::Result<ReplayOutcome>;

    /// Short label for tracing (e.g. `"local"` / `"remote"` / `"mock"`).
    fn name(&self) -> &'static str;
}

// ── Local binary backend ─────────────────────────────────────────────

/// Default local binary name. The replay engine ships as
/// `substrate-v2-replay` per `project_substrate_v2_replay_engine.md`;
/// users can override via `INARI_REPLAY_BINARY` if they package it
/// somewhere `which` can't see.
pub const DEFAULT_LOCAL_BINARY: &str = "substrate-v2-replay";

/// Hard timeout for the local subprocess. 30s mirrors the Sesión 17
/// RaaS endpoint's request budget; replays larger than that are left
/// to the dock-driven manual flow.
const LOCAL_TIMEOUT: Duration = Duration::from_secs(30);

/// Backend that exec's the `substrate-v2-replay` binary on the user's
/// machine. JSON I/O over stdout — see the v2 replay engine README for
/// the exact payload shape.
pub struct LocalReplayBackend {
    pub binary_path: PathBuf,
}

impl LocalReplayBackend {
    /// Resolve the binary by name (consulting `INARI_REPLAY_BINARY`
    /// first, then `which`). Returns `None` when neither produces a
    /// hit — the actor falls through to the remote backend.
    pub fn from_path() -> Option<Self> {
        let override_path = std::env::var("INARI_REPLAY_BINARY").ok();
        if let Some(p) = override_path {
            let pb = PathBuf::from(&p);
            if pb.exists() {
                return Some(Self { binary_path: pb });
            }
        }
        let resolved = which::which(DEFAULT_LOCAL_BINARY).ok()?;
        Some(Self { binary_path: resolved })
    }
}

impl ReplayBackend for LocalReplayBackend {
    fn replay(
        &self,
        recording_dir: &Path,
        source_overlay: &Path,
    ) -> std::io::Result<ReplayOutcome> {
        let mut cmd = Command::new(&self.binary_path);
        cmd.arg("--recording").arg(recording_dir);
        cmd.arg("--overlay").arg(source_overlay);
        cmd.arg("--json");
        // No env var inheritance defenses — the replay binary is local
        // user code, same trust boundary as the daemon itself.
        let child = cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()?;

        let output = wait_with_timeout(child, LOCAL_TIMEOUT)?;
        if !output.status.success() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!(
                    "substrate-v2-replay exited with status {} — stderr {}",
                    output.status,
                    String::from_utf8_lossy(&output.stderr).trim(),
                ),
            ));
        }

        let parsed: ReplayDto = serde_json::from_slice(&output.stdout).map_err(|e| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("substrate-v2-replay JSON: {e}"),
            )
        })?;
        Ok(parsed.into_outcome())
    }

    fn name(&self) -> &'static str { "local" }
}

/// Block on a child process up to `timeout`. On timeout, the child is
/// killed and `Err(TimedOut)` returned — same ergonomics as the
/// `tokio::time::timeout` flow but staying synchronous so we can wrap
/// the whole `replay()` call inside a single `spawn_blocking`.
fn wait_with_timeout(
    mut child: std::process::Child,
    timeout: Duration,
) -> std::io::Result<std::process::Output> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if let Some(_status) = child.try_wait()? {
            return child.wait_with_output();
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "substrate-v2-replay timed out",
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

// ── Remote /v2/replay backend ────────────────────────────────────────

/// Default request budget for the remote `/v2/replay` POST. Mirrors
/// the local timeout so callers see a consistent 30s ceiling.
const REMOTE_TIMEOUT: Duration = Duration::from_secs(30);

/// Backend that POSTs to `${INARI_STAGING_URL}/v2/replay`. Wraps
/// `reqwest::blocking::Client` so the actor's `spawn_blocking` call
/// can drive both impls through one trait without an async colour
/// split. The response shape is captured by [`RemoteResponse`] —
/// only the metadata fields cross the wire.
pub struct RemoteReplayBackend {
    pub endpoint: String,
    pub token:    String,
    pub client:   reqwest::blocking::Client,
}

impl RemoteReplayBackend {
    /// Resolve from env vars. Returns `None` when either is missing —
    /// the actor falls through to logging "no backend available".
    pub fn from_env() -> Option<Self> {
        let raw_url   = std::env::var("INARI_STAGING_URL").ok()?;
        let token     = std::env::var("INARI_STAGING_TOKEN").ok()?;
        let endpoint  = format!("{}/v2/replay", raw_url.trim_end_matches('/'));
        let client    = reqwest::blocking::Client::builder()
            .timeout(REMOTE_TIMEOUT)
            .build()
            .ok()?;
        Some(Self { endpoint, token, client })
    }
}

impl ReplayBackend for RemoteReplayBackend {
    fn replay(
        &self,
        recording_dir: &Path,
        source_overlay: &Path,
    ) -> std::io::Result<ReplayOutcome> {
        // Recording id is the directory name. The Sesión 17 endpoint
        // (project_replay_as_a_service.md) accepts a `recording_id`
        // and a base64 source overlay; we send the bare name here so
        // the staging server can fetch the recording by id from its
        // own store (the dock has already uploaded it via Capture).
        let recording_id = recording_dir
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "recording_dir has no terminal component",
            ))?
            .to_string();

        let overlay_bytes = std::fs::read(source_overlay)?;
        let req = PostBody {
            recording_id,
            overlay_path:  source_overlay.display().to_string(),
            overlay_bytes: base64_encode(&overlay_bytes),
        };

        let res = self.client
            .post(&self.endpoint)
            .bearer_auth(&self.token)
            .json(&req)
            .send()
            .map_err(io_err)?;

        if !res.status().is_success() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("remote /v2/replay returned status {}", res.status()),
            ));
        }

        let parsed: ReplayDto = res.json().map_err(io_err)?;
        Ok(parsed.into_outcome())
    }

    fn name(&self) -> &'static str { "remote" }
}

fn io_err(e: reqwest::Error) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
}

// ── Wire DTOs ────────────────────────────────────────────────────────
//
// `ReplayDto` matches the JSON the local binary writes to stdout AND
// the JSON the remote endpoint returns. Keeping a single shape across
// both impls lets the actor stay backend-agnostic.

/// On-wire response shape. Mirrors the v2 binary's JSON output
/// (Substrate v0.1.2 §replay-engine) and the Sesión 17 RaaS endpoint's
/// reply.
#[derive(Debug, Deserialize)]
struct ReplayDto {
    /// Whether replay drained without behavioural divergence.
    /// Defaults to `true` so a stripped-down response (e.g. binary
    /// emits only `{}`) is treated as a benign match rather than a
    /// silent failure.
    #[serde(default = "default_true")]
    matched:   bool,
    /// Optional divergence detail. Absent on `matched=true`.
    #[serde(default)]
    divergence: Option<DivergenceDto>,
}

fn default_true() -> bool { true }

/// Same shape as [`DivergenceSummary`] but wire-typed with optional
/// fields so a partially-populated response from a future v2 binary
/// version doesn't panic at parse time.
#[derive(Debug, Deserialize)]
struct DivergenceDto {
    kind:            Option<DivergenceKind>,
    affected_module: Option<String>,
    severity:        Option<DivergenceSeverity>,
}

impl ReplayDto {
    fn into_outcome(self) -> ReplayOutcome {
        if self.matched && self.divergence.is_none() {
            return ReplayOutcome::matched();
        }
        let div = self.divergence.unwrap_or(DivergenceDto {
            kind: None, affected_module: None, severity: None,
        });
        let summary = DivergenceSummary {
            kind:            div.kind.unwrap_or(DivergenceKind::IoMismatch),
            affected_module: div.affected_module.unwrap_or_else(|| "unknown".into()),
            severity:        div.severity.unwrap_or(DivergenceSeverity::Medium),
        };
        ReplayOutcome { matched: self.matched, divergence: Some(summary) }
    }
}

/// Outbound payload for the remote backend. Kept tiny on purpose —
/// the staging endpoint should already have the recording bytes (the
/// dock uploads them on Substrate flush). `overlay_bytes` is base64'd
/// raw file contents; the endpoint applies the overlay onto the
/// replayed source tree before invoking `substrate-v2-replay`.
#[derive(Debug, Serialize)]
struct PostBody {
    recording_id:  String,
    overlay_path:  String,
    overlay_bytes: String,
}

/// Tiny base64 encoder so we don't pull `base64` for one helper. The
/// remote backend is the only call site; if usage grows we'll swap it
/// for the crate.
fn base64_encode(input: &[u8]) -> String {
    const CHARS: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    let mut chunks = input.chunks_exact(3);
    for chunk in chunks.by_ref() {
        let n = (u32::from(chunk[0]) << 16)
              | (u32::from(chunk[1]) <<  8)
              |  u32::from(chunk[2]);
        out.push(CHARS[((n >> 18) & 0x3F) as usize] as char);
        out.push(CHARS[((n >> 12) & 0x3F) as usize] as char);
        out.push(CHARS[((n >>  6) & 0x3F) as usize] as char);
        out.push(CHARS[( n        & 0x3F) as usize] as char);
    }
    let rem = chunks.remainder();
    match rem.len() {
        1 => {
            let n = u32::from(rem[0]) << 16;
            out.push(CHARS[((n >> 18) & 0x3F) as usize] as char);
            out.push(CHARS[((n >> 12) & 0x3F) as usize] as char);
            out.push('=');
            out.push('=');
        }
        2 => {
            let n = (u32::from(rem[0]) << 16) | (u32::from(rem[1]) << 8);
            out.push(CHARS[((n >> 18) & 0x3F) as usize] as char);
            out.push(CHARS[((n >> 12) & 0x3F) as usize] as char);
            out.push(CHARS[((n >>  6) & 0x3F) as usize] as char);
            out.push('=');
        }
        _ => {}
    }
    out
}

// ── Auto-resolve: production default ─────────────────────────────────

/// Pick the best backend available at startup. Returns `None` when
/// neither path resolves — see module doc for the policy.
pub fn auto_backend() -> Option<Box<dyn ReplayBackend>> {
    if let Some(local) = LocalReplayBackend::from_path() {
        tracing::info!(
            sensor = super::SUBSTRATE_SENSOR_NAME,
            backend = "local",
            binary  = %local.binary_path.display(),
            "substrate replay backend resolved",
        );
        return Some(Box::new(local));
    }
    if let Some(remote) = RemoteReplayBackend::from_env() {
        tracing::info!(
            sensor = super::SUBSTRATE_SENSOR_NAME,
            backend = "remote",
            endpoint = %remote.endpoint,
            "substrate replay backend resolved",
        );
        return Some(Box::new(remote));
    }
    tracing::info!(
        sensor = super::SUBSTRATE_SENSOR_NAME,
        "no substrate replay backend available — sensor will run inert",
    );
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dto_matched_no_divergence_round_trips_to_outcome() {
        let json = r#"{"matched": true}"#;
        let dto: ReplayDto = serde_json::from_str(json).unwrap();
        let outcome = dto.into_outcome();
        assert!(outcome.matched);
        assert!(outcome.divergence.is_none());
    }

    #[test]
    fn dto_diverged_high_severity_round_trips_to_outcome() {
        let json = r#"{
            "matched": false,
            "divergence": {
                "kind": "io_mismatch",
                "affected_module": "express/router",
                "severity": "high"
            }
        }"#;
        let dto: ReplayDto = serde_json::from_str(json).unwrap();
        let outcome = dto.into_outcome();
        assert!(!outcome.matched);
        let div = outcome.divergence.expect("divergence present");
        assert_eq!(div.kind, DivergenceKind::IoMismatch);
        assert_eq!(div.affected_module, "express/router");
        assert_eq!(div.severity, DivergenceSeverity::High);
    }

    #[test]
    fn dto_partial_divergence_falls_back_to_safe_defaults() {
        // Future v2 binary that emits a partial divergence record —
        // we should never panic, falling back to medium io_mismatch.
        let json = r#"{"matched": false, "divergence": {}}"#;
        let dto: ReplayDto = serde_json::from_str(json).unwrap();
        let outcome = dto.into_outcome();
        assert!(!outcome.matched);
        let div = outcome.divergence.unwrap();
        assert_eq!(div.kind, DivergenceKind::IoMismatch);
        assert_eq!(div.severity, DivergenceSeverity::Medium);
        assert_eq!(div.affected_module, "unknown");
    }

    #[test]
    fn dto_empty_object_treated_as_matched() {
        // Minimal binary may emit `{}` to mean "ran cleanly". We treat
        // the empty object as a benign match so a future stripped-down
        // mode isn't silently a failure.
        let json = r#"{}"#;
        let dto: ReplayDto = serde_json::from_str(json).unwrap();
        let outcome = dto.into_outcome();
        assert!(outcome.matched);
        assert!(outcome.divergence.is_none());
    }

    #[test]
    fn post_body_serializes_compactly() {
        let body = PostBody {
            recording_id:  "11111111-2222-3333-4444-555555555555".into(),
            overlay_path:  "src/handler.ts".into(),
            overlay_bytes: base64_encode(b"hello"),
        };
        let json = serde_json::to_string(&body).unwrap();
        // Cheap shape check: the staging endpoint expects this exact
        // top-level key set per project_replay_as_a_service.md.
        assert!(json.contains("\"recording_id\""));
        assert!(json.contains("\"overlay_path\""));
        assert!(json.contains("\"overlay_bytes\""));
        assert!(json.contains("11111111-2222-3333-4444-555555555555"));
        // base64("hello") = "aGVsbG8="
        assert!(json.contains("aGVsbG8="));
    }

    #[test]
    fn base64_known_vectors() {
        assert_eq!(base64_encode(b""),       "");
        assert_eq!(base64_encode(b"f"),      "Zg==");
        assert_eq!(base64_encode(b"fo"),     "Zm8=");
        assert_eq!(base64_encode(b"foo"),    "Zm9v");
        assert_eq!(base64_encode(b"foob"),   "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"),  "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }
}
