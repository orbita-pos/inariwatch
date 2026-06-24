//! Substrate adapters consumed by [`crate::dispatch`]. Each adapter
//! turns a resolved [`crate::rules::Target`] into actual model output.
//!
//! Today:
//! - [`cloud_proxy`] — dual-mode (direct provider call OR HTTP proxy to
//!   web's `/api/ai/dispatch`). Owns the lockdown URL boundary by
//!   delegating to [`crate::providers`].
//! - [`llamacpp`] — declarative trait. Inari Live's existing
//!   `desktop/src-tauri/.../llama_runtime.rs` (Sesión 21) implements it
//!   from the desktop crate; this crate has zero `tauri-*` dependency.

pub mod cloud_proxy;
pub mod llamacpp;
