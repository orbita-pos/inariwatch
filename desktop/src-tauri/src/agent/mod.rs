//! Inari Live's chat-agent foundation. Defines the [`ChatTool`] trait,
//! the [`ToolRegistry`] that holds tool implementations and discovers
//! skills from the user's workspace, the permission decision pipeline,
//! and the Witness-backed audit trail.
//!
//! See `INARI_LIVE_AGENT_PLAN.md` §S2 for the design intent. Concrete
//! tool implementations live in submodules added in later sessions
//! (S3 = desktop OS tools, S4 = local exec, S5 = communication).
//!
//! Locked architectural decisions for this module (Jesus approved
//! 2026-05-06):
//!
//! 1. Lives in `desktop/src-tauri/src/agent/` as a Rust module — not
//!    a separate crate, not in `ai-router-rs`.
//! 2. `ChatTool::execute` returns `serde_json::Value` — JSON wire
//!    shape matches MCP / function-calling.
//! 3. `PermissionLevel` is `Auto | Confirm | Deny`. Default for
//!    writes/sends/exec = `Confirm`; reads/queries = `Auto`. `Deny`
//!    is configurable but never default.
//! 4. Audit log = local SQLite via [`crate::store`]. Not cloud-synced.
//! 5. Skills under `~/.inari/workspace/skills/<name>/SKILL.md` with
//!    `manifest.json` + `AGENTS.md` siblings. We picked `AGENTS.md` —
//!    no `CLAUDE.md` symlink.
//! 6. Skill loader emits diagnostic events on rejection (the OpenClaw
//!    failure mode we explicitly want to fix).
//! 7. Witness receipt emission is automatic — implementations of
//!    [`ChatTool`] don't have to remember to emit. The registry's
//!    invoke wrapper does it for them.

pub mod audit;
pub mod permission;
pub mod registry;
pub mod skill;
pub mod tool;
pub mod tools;
pub mod witness;

pub use audit::{AuditEntry, AuditError, AuditFilter, AuditLog, AuditOrder, AuditPage};
pub use permission::{PermissionDecision, PermissionLevel, PermissionResolver};
pub use registry::{RegistryError, ToolRegistry};
pub use skill::{Skill, SkillEvent, SkillLoader, SkillLoaderError, SkillManifest, WatcherHandle};
pub use tool::{ChatTool, ToolError, ToolInvocation, ToolMeta, ToolOutput};
pub use witness::{InMemoryReceiptSink, ReceiptSink, WitnessEmitter, WitnessOpen, WitnessReceipt};
