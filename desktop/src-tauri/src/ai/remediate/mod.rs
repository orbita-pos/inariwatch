//! Remediation pipeline.
//!
//! Sesión 19 reorganises this module into a 3-way split:
//!
//! - [`single_shot`]  — local, AI-only path. Reads context from the
//!                      indexer + episodic memory + disk, asks gpt-5.4
//!                      for a unified diff, returns it for user
//!                      approval. NO push, NO commit until apply.
//! - [`proxy`]        — cloud-proxied agentic path (RENAMED from
//!                      `cloud_proxy`). Sesión 4 shipped the original
//!                      bridge to `/api/desktop/autofix/*`; Sesión 19
//!                      adds [`proxy::run_cloud_agentic`] for the new
//!                      `/api/cli/remediation/trigger` flow + SSE stream
//!                      from `/api/remediation/stream/<id>`.
//! - [`orchestrator`] — router. Picks local vs cloud based on workspace
//!                      connection + complexity heuristics. Owns the
//!                      `apply_diff` / `reject_diff` apply-side surface.

pub mod orchestrator;
pub mod proxy;
pub mod single_shot;

pub use orchestrator::{apply_diff, reject_diff, route_remediation};
