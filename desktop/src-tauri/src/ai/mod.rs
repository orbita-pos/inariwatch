//! AI surface — OpenAI client (Session 18), remediation pipeline
//! (Session 19). Session 4 lands the cloud-proxied autofix bridge
//! under `remediate/cloud_proxy.rs` (renamed from the pre-Session-4
//! `src/autofix.rs`); single-shot + orchestrator are added in
//! Session 19.

pub mod budget;
pub mod openai;
pub mod prompts;
pub mod remediate;
pub mod streaming;
