//! AI surface — OpenAI client (Session 18), remediation pipeline
//! (Session 19). Session 4 originally landed the cloud-proxied autofix
//! bridge under `remediate/cloud_proxy.rs` (renamed from the pre-Session-4
//! `src/autofix.rs`); Sesión 19 renames it again to `remediate/proxy.rs`
//! and adds `single_shot` + `orchestrator` as peer modules.

pub mod budget;
pub mod diff_repair;
pub mod openai;
pub mod prompts;
pub mod remediate;
// Layer 1 intent classifier — nearest-centroid over MiniLM-L6-v2
// embeddings. Reuses the fastembed singleton from `crate::indexer::embeddings`
// so no second model load is needed. Exposed to TypeScript via
// `ipc::classify::classify_intent_semantic`.
pub mod semantic_classifier;
pub mod streaming;
