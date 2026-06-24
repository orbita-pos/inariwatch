//! Local-subset gate runner (Sesión 20).
//!
//! Sesión 8 already ships a sync evaluator at
//! [`crate::sensors::git::gate::evaluate`] that handles Gates 1
//! (`auto_merge_enabled`) and 4 (`lines_changed`) — those are
//! settings/diff-size lookups with zero IO, so the pre-push HTTP
//! handler runs them inline. This module owns the *async* gates that
//! involve AI calls or sub-processes:
//!
//!   * Gate 5 — `self_review`        (AI confidence ≥ 70)
//!   * Gate 6 — `substrate_simulate` (replay risk ≤ 40)
//!   * Gate 9 — `security_scan`      (zero HIGH findings from the
//!                                    19-regex Semgrep-inspired set
//!                                    ported from `web/lib/ai/security-scan.ts`)
//!
//! Why a separate module from `sensors::git::gate`: the sync evaluator
//! returns instantly and the hook handler can return its decision in
//! the same request loop. The async runner here can take seconds (AI
//! call ≈ 1-3s, replay sub-process ≈ 100ms-30s, security scan O(diff
//! size)). The hook handler kicks the runner under a 30s deadline; on
//! timeout the verdict defaults to `allow=false` with reason "gate
//! runner timeout — try again or use [Push anyway]". Gate 6 default-
//! allows when no recording is available within the 60s window
//! (substrate is opt-in per repo).

pub mod local_subset;
pub mod runner;

pub use runner::{run_local_subset, GateRunInput, GateRunOutcome, GateRunVerdict};
