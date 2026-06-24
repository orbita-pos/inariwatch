//! S6 — chat-agent tool-invocation IPC surface.
//!
//! Three commands, all reading from the shared [`crate::agent::ToolRegistry`]
//! that `lib.rs::run()` instantiates at boot:
//!
//! | Command                  | Purpose                                                |
//! |--------------------------|--------------------------------------------------------|
//! | `desktop_tool_invoke`    | Run a tool with its `default_permission` gate active.  |
//! | `desktop_tool_confirm`   | Re-run the same tool after the UI showed a confirm.    |
//! | `desktop_tool_catalog`   | Enumerate the registered tools (for the LLM + UI).     |
//!
//! `_invoke` returns a tagged [`InvokeOutcome`] so the chat surface can
//! distinguish three terminal states without parsing error strings:
//!
//! - `output` — tool ran, registry persisted the audit row + receipt.
//!   The frontend renders the row and offers the witness chip pointing
//!   at the returned `invocation_id` (S11's verifier modal does the
//!   re-hash + display).
//! - `requires_confirm` — `Confirm`-level tool short-circuited; the UI
//!   shows `[Confirm] [Cancel]` inline and re-dispatches via
//!   `_confirm`. We intentionally don't cache the pending invocation
//!   on the backend — the frontend owns the args + name and re-hands
//!   them to us, which keeps the IPC stateless.
//! - `denied` — user override or tool default is `Deny`. The frontend
//!   surfaces the row with a deeplink into Settings → Permissions
//!   focused on the offending tool.
//!
//! `_confirm` always treats the call as `invoke_traced_confirmed` (no
//! second permission gate). Schema-invalid args still fail and audit a
//! failure row — the registry handles that.
//!
//! `_catalog` mirrors [`crate::agent::tools::catalog_all`] but lifts
//! it into a wire shape (`ToolMetaDto`) so the existing IPC tagged-
//! union convention holds. Order is stable: cluster registration order
//! (`desktop_os` → `local_exec` → `comm`).

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;

use crate::agent::tools::catalog_all;
use crate::agent::{
    PermissionLevel, RegistryError, ToolError, ToolMeta, ToolOutput, ToolRegistry,
};

use super::error::IpcError;

/// Wire shape of [`ToolMeta`] for the catalog endpoint. Mirrors the
/// Rust struct verbatim (snake_case via serde) so the LLM tool catalog
/// + the frontend permission settings UI consume the same row.
#[derive(Debug, Clone, Serialize)]
pub struct ToolMetaDto {
    pub name: String,
    pub description: String,
    pub params_schema: Value,
    pub default_permission: PermissionLevel,
}

impl From<ToolMeta> for ToolMetaDto {
    fn from(m: ToolMeta) -> Self {
        ToolMetaDto {
            name: m.name,
            description: m.description,
            params_schema: m.params_schema,
            default_permission: m.default_permission,
        }
    }
}

/// Minimal `ToolOutput` projection for the wire. Mirrors the Rust
/// shape — schema is per-tool and the chat surface renders it
/// generically (JSON view).
#[derive(Debug, Clone, Serialize)]
pub struct ToolOutputDto {
    pub value: Value,
    pub summary: Option<String>,
}

impl From<ToolOutput> for ToolOutputDto {
    fn from(o: ToolOutput) -> Self {
        ToolOutputDto {
            value: o.value,
            summary: o.summary,
        }
    }
}

/// Outcome of a `desktop_tool_invoke` call. Tagged on the wire so the
/// frontend matches on `kind` rather than parsing strings. Mirrors the
/// `RegistryError::{RequiresConfirm, PermissionDenied}` short-circuit
/// branches plus the success shape.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InvokeOutcome {
    /// Tool ran and the registry persisted an audit row. The frontend
    /// uses `invocation_id` to drive the S11 verifier modal.
    Output {
        invocation_id: String,
        output:        ToolOutputDto,
        /// Echoes the registered `default_permission` so the chat
        /// surface can render the badge ("auto" / "confirm") even on
        /// a successful one-shot invoke.
        permission:    PermissionLevel,
    },
    /// Tool's `default_permission` is `Confirm`. The frontend shows
    /// inline `[Confirm] [Cancel]` and re-dispatches via
    /// `desktop_tool_confirm` with the same args.
    RequiresConfirm {
        tool: String,
        /// Echoed back so the frontend doesn't need to look up the
        /// catalog to know what permission level to render.
        permission: PermissionLevel,
    },
    /// User has overridden the tool to `Deny` (or the tool's default
    /// is `Deny`). The frontend renders a "permission denied" row
    /// with a deeplink to Settings → Permissions.
    Denied { tool: String, reason: String },
}

#[tauri::command]
pub async fn desktop_tool_catalog(
    _registry: tauri::State<'_, Arc<ToolRegistry>>,
) -> Result<Vec<ToolMetaDto>, IpcError> {
    // Use `catalog_all()` rather than `registry.list()` so the catalog
    // is stable even if a cluster failed to construct at boot (the
    // settings UI already keys on the static catalog; matching here
    // keeps the two surfaces in lock-step).
    Ok(catalog_all().into_iter().map(ToolMetaDto::from).collect())
}

#[tauri::command]
pub async fn desktop_tool_invoke(
    tool_name: String,
    args:      Value,
    session_id: Option<String>,
    registry:   tauri::State<'_, Arc<ToolRegistry>>,
) -> Result<InvokeOutcome, IpcError> {
    // Match on default_permission via the catalog so we can surface
    // the correct `permission` field in `RequiresConfirm` / `Output`.
    let meta_perm = catalog_all()
        .into_iter()
        .find(|m| m.name == tool_name)
        .map(|m| m.default_permission);

    let result = registry
        .inner()
        .invoke_traced(&tool_name, args, session_id)
        .await;

    map_registry_result(&tool_name, meta_perm, result)
}

#[tauri::command]
pub async fn desktop_tool_confirm(
    tool_name: String,
    args:      Value,
    session_id: Option<String>,
    registry:   tauri::State<'_, Arc<ToolRegistry>>,
) -> Result<InvokeOutcome, IpcError> {
    let meta_perm = catalog_all()
        .into_iter()
        .find(|m| m.name == tool_name)
        .map(|m| m.default_permission);

    let result = registry
        .inner()
        .invoke_traced_confirmed(&tool_name, args, session_id)
        .await;

    map_registry_result(&tool_name, meta_perm, result)
}

/// User-typed `/<command>` entry point. Same wire shape as
/// `desktop_tool_invoke` but the registry is told it's a slash
/// invocation: bypasses the `Confirm` gate (the typing IS the consent)
/// AND records `source = "slash"` on the audit row.
///
/// `Deny` overrides are still respected per Option A of the trust-
/// ladder design — when the user has set a tool to Deny in Settings
/// the slash command cannot bypass that. The `Denied` outcome
/// surfaces a friendly message pointing the user at Settings →
/// Permissions so they know how to enable the tool. RequiresConfirm
/// is unreachable here (slash bypasses Confirm); the standard mapper
/// still handles it defensively in case the registry semantics
/// shift later.
#[tauri::command]
pub async fn desktop_tool_invoke_via_slash(
    tool_name: String,
    args:      Value,
    session_id: Option<String>,
    registry:   tauri::State<'_, Arc<ToolRegistry>>,
) -> Result<InvokeOutcome, IpcError> {
    let meta_perm = catalog_all()
        .into_iter()
        .find(|m| m.name == tool_name)
        .map(|m| m.default_permission);

    let result = registry
        .inner()
        .invoke_traced_via_slash(&tool_name, args, session_id)
        .await;

    // Customize the Denied reason so the chat surface can show a
    // helpful message instead of the generic "permission denied".
    if matches!(result, Err(RegistryError::PermissionDenied)) {
        return Ok(InvokeOutcome::Denied {
            tool: tool_name.clone(),
            reason: format!(
                "Tool `{tool_name}` is set to Deny in Settings → Permissions. \
                 Change it to Confirm or Auto if you want this slash command \
                 to invoke it.",
            ),
        });
    }

    map_registry_result(&tool_name, meta_perm, result)
}

/// Translate a [`RegistryError`] into either an [`InvokeOutcome`]
/// (for the three short-circuit cases the chat surface needs) or an
/// [`IpcError`] (for genuine failures the UI surfaces as an error
/// toast).
fn map_registry_result(
    tool_name: &str,
    meta_perm: Option<PermissionLevel>,
    result:    Result<(String, ToolOutput), RegistryError>,
) -> Result<InvokeOutcome, IpcError> {
    match result {
        Ok((invocation_id, output)) => Ok(InvokeOutcome::Output {
            invocation_id,
            output: output.into(),
            // Default permission is the cleanest source — registry
            // doesn't surface decision back to the IPC layer post-success.
            permission: meta_perm.unwrap_or(PermissionLevel::Auto),
        }),
        Err(RegistryError::RequiresConfirm) => Ok(InvokeOutcome::RequiresConfirm {
            tool: tool_name.to_string(),
            permission: meta_perm.unwrap_or(PermissionLevel::Confirm),
        }),
        Err(RegistryError::PermissionDenied) => Ok(InvokeOutcome::Denied {
            tool: tool_name.to_string(),
            reason: "permission denied".to_string(),
        }),
        Err(RegistryError::UnknownTool(name)) => Err(IpcError::internal(format!(
            "unknown tool: {name}"
        ))),
        Err(RegistryError::SchemaInvalid(reason)) => Err(IpcError::internal(format!(
            "schema invalid: {reason}"
        ))),
        Err(RegistryError::Tool(ToolError::Timeout(d))) => {
            Err(IpcError::internal(format!("timeout after {d:?}")))
        }
        Err(RegistryError::Tool(e)) => Err(IpcError::internal(e.to_string())),
        Err(other) => Err(IpcError::internal(format!("registry error: {other}"))),
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────
//
// The handlers above are thin shells around `ToolRegistry::invoke_traced`
// (covered by `agent::registry::tests`) plus a wire conversion. The
// integration test suite in `tests/ipc_tool_invoke.rs` exercises the
// full surface end-to-end using mock backends; these unit tests cover
// the conversion logic and the `RegistryError → InvokeOutcome` mapping
// so the wire shape stays locked.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::tool::ToolError as InnerToolError;

    #[test]
    fn map_ok_returns_output_variant_carrying_invocation_id() {
        let outcome = map_registry_result(
            "desktop.read_file",
            Some(PermissionLevel::Auto),
            Ok((
                "inv-1".to_string(),
                ToolOutput {
                    value: serde_json::json!({"ok": true}),
                    summary: Some("read /tmp/x".into()),
                },
            )),
        )
        .expect("ok");
        match outcome {
            InvokeOutcome::Output {
                invocation_id,
                output,
                permission,
            } => {
                assert_eq!(invocation_id, "inv-1");
                assert_eq!(output.value, serde_json::json!({"ok": true}));
                assert_eq!(output.summary.as_deref(), Some("read /tmp/x"));
                assert_eq!(permission, PermissionLevel::Auto);
            }
            other => panic!("expected Output, got {other:?}"),
        }
    }

    #[test]
    fn map_requires_confirm_returns_requires_confirm_variant() {
        let outcome = map_registry_result(
            "local.run_shell",
            Some(PermissionLevel::Confirm),
            Err(RegistryError::RequiresConfirm),
        )
        .expect("ok");
        match outcome {
            InvokeOutcome::RequiresConfirm { tool, permission } => {
                assert_eq!(tool, "local.run_shell");
                assert_eq!(permission, PermissionLevel::Confirm);
            }
            other => panic!("expected RequiresConfirm, got {other:?}"),
        }
    }

    #[test]
    fn map_permission_denied_returns_denied_variant() {
        let outcome = map_registry_result(
            "comm.send_whatsapp",
            Some(PermissionLevel::Confirm),
            Err(RegistryError::PermissionDenied),
        )
        .expect("ok");
        match outcome {
            InvokeOutcome::Denied { tool, reason } => {
                assert_eq!(tool, "comm.send_whatsapp");
                assert!(reason.contains("denied"));
            }
            other => panic!("expected Denied, got {other:?}"),
        }
    }

    #[test]
    fn map_unknown_tool_returns_ipc_error() {
        let err = map_registry_result(
            "ghost.tool",
            None,
            Err(RegistryError::UnknownTool("ghost.tool".into())),
        )
        .expect_err("must error");
        let msg = format!("{err}");
        assert!(msg.contains("unknown tool"), "got: {msg}");
    }

    #[test]
    fn map_schema_invalid_returns_ipc_error() {
        let err = map_registry_result(
            "desktop.read_file",
            Some(PermissionLevel::Auto),
            Err(RegistryError::SchemaInvalid(
                "missing required field 'path'".into(),
            )),
        )
        .expect_err("must error");
        let msg = format!("{err}");
        assert!(msg.contains("schema invalid"), "got: {msg}");
    }

    #[test]
    fn map_tool_execution_failed_returns_ipc_error_with_message() {
        let err = map_registry_result(
            "local.run_shell",
            Some(PermissionLevel::Confirm),
            Err(RegistryError::Tool(InnerToolError::ExecutionFailed(
                "spawn failed: ENOENT".into(),
            ))),
        )
        .expect_err("must error");
        let msg = format!("{err}");
        assert!(msg.contains("ENOENT"), "got: {msg}");
    }
}
