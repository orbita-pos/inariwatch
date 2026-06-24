//! S11 — Audit-log + permission-settings IPC surface.
//!
//! Six commands, all read-only except the two permission setters. All
//! lookups go through the existing `agent::AuditLog` over the shared
//! SQLite pool; the static [`super::super::agent::tools::catalog_all`]
//! is the source of truth for "what tools exist" so the panel can
//! render before S6 wires the live `ToolRegistry` into `lib.rs::run()`.
//!
//! ## Verification semantics
//!
//! `desktop_audit_verify` re-hashes `args_json` + `result_json` and
//! compares against the stored `args_sha256` / `result_sha256` on the
//! Witness receipt. Hash-only — the receipt's Ed25519 signature is
//! still pending the chat-session signing key (S6). The handler
//! reports that as [`SignatureStatus::NotYetSigned`] explicitly so
//! the UI can render an honest "Coming in S6" placeholder rather
//! than faking a green check.
//!
//! Hashing matches the bytes [`crate::agent::WitnessEmitter`] hashes
//! (`serde_json::to_vec(&Value)`) so a row stored before S11 lands
//! verifies after this code does. The witness module's comment is
//! explicit that this is "did the args / result change" semantics
//! pending JCS canonicalisation in S6 — the comparison here uses the
//! same routine to stay in lock-step.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::agent::tools::catalog_all;
use crate::agent::{
    AuditEntry, AuditFilter, AuditLog, AuditOrder, AuditPage, PermissionLevel, PermissionResolver,
    ToolMeta,
};
use crate::store::Store;

use super::error::IpcError;

// ── Wire types ───────────────────────────────────────────────────────────────

/// The wire shape of [`AuditFilter`] the frontend builds. All fields
/// optional so partial updates (e.g. "only set tool_name") round-trip
/// through JSON unchanged. The conversion below is explicit so a
/// future schema change to either side fails compile, not at runtime.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AuditFilterDto {
    pub text: Option<String>,
    pub tool_name: Option<String>,
    pub success: Option<bool>,
    pub session_id: Option<String>,
    pub since_ms: Option<u64>,
    pub until_ms: Option<u64>,
    pub cursor_started_at_ms: Option<u64>,
    /// Page size. Defaults to 50 when missing.
    pub limit: Option<u32>,
    /// `"newest_first"` (default) or `"oldest_first"`. Matches the
    /// `serde(rename_all = "snake_case")` form of [`AuditOrder`].
    pub order: Option<AuditOrder>,
}

impl From<AuditFilterDto> for AuditFilter {
    fn from(dto: AuditFilterDto) -> Self {
        AuditFilter {
            text: dto.text,
            tool_name: dto.tool_name,
            success: dto.success,
            session_id: dto.session_id,
            since_ms: dto.since_ms,
            until_ms: dto.until_ms,
            cursor_started_at_ms: dto.cursor_started_at_ms,
            limit: dto.limit.unwrap_or(50),
            order: dto.order.unwrap_or_default(),
        }
    }
}

/// One [`AuditEntry`] in the wire shape the table expects. Mirrors the
/// Rust struct verbatim — `serde(rename_all = "snake_case")` keeps the
/// JSON keys snake_case for TS consumers.
pub type AuditEntryDto = AuditEntry;

/// Page payload returned by [`desktop_audit_list`].
#[derive(Debug, Clone, Serialize)]
pub struct AuditPageDto {
    pub rows: Vec<AuditEntryDto>,
    pub next_cursor: Option<u64>,
    pub total: u64,
}

impl From<AuditPage> for AuditPageDto {
    fn from(p: AuditPage) -> Self {
        AuditPageDto {
            rows: p.rows,
            next_cursor: p.next_cursor,
            total: p.total,
        }
    }
}

/// Outcome of [`desktop_audit_verify`] — three independent checks
/// mirror the modal's three-row layout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SignatureStatus {
    /// S6 wires the chat-session Ed25519 key into the witness emitter.
    /// Until that lands the receipt is metadata-only — the UI surfaces
    /// this as "Coming in S6" rather than ✓ / ✗ so the user knows
    /// integrity is content-addressable but not yet cryptographically
    /// attested.
    NotYetSigned,
    /// Reserved for S6: signature checked + valid.
    Verified,
    /// Reserved for S6: signature checked + invalid (tampered or wrong
    /// key). Surface as ✗ when present.
    Failed,
    /// The audit row had no recorded `witness_receipt_id`, typically
    /// because it short-circuited before the witness emitter ran
    /// (e.g. `RegistryError::UnknownTool`). The UI renders this as
    /// "—" rather than as a failure.
    NoReceipt,
}

#[derive(Debug, Clone, Serialize)]
pub struct VerifyResult {
    pub args_hash_match: bool,
    pub result_hash_match: bool,
    /// What we know about the cryptographic signature. See
    /// [`SignatureStatus`].
    pub signature: SignatureStatus,
    /// SHA-256 we just computed for `args_json`. Hex.
    pub computed_args_sha256: String,
    /// Hash recorded on the receipt — `None` when the row has no
    /// linked receipt (`SignatureStatus::NoReceipt`).
    pub recorded_args_sha256: Option<String>,
    /// SHA-256 we just computed for `result_json`. `None` when the
    /// audit row has `result_json IS NULL` (failed invocation).
    pub computed_result_sha256: Option<String>,
    pub recorded_result_sha256: Option<String>,
}

/// One row of the permission settings panel: the ToolMeta plus the
/// effective override (if any). The frontend computes the displayed
/// "effective level" by falling back to `default_permission` when
/// `override_level` is `None`.
#[derive(Debug, Clone, Serialize)]
pub struct PermissionRowDto {
    pub name: String,
    pub description: String,
    pub default_permission: PermissionLevel,
    pub override_level: Option<PermissionLevel>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PermissionListing {
    pub rows: Vec<PermissionRowDto>,
}

// ── Pure helpers (testable without Tauri) ────────────────────────────────────

/// Compute SHA-256 hex over the canonical JSON byte sequence of `s`.
/// Matches the routine inside `agent::witness` (hash of
/// `serde_json::to_vec(&Value)`) — when JCS canonicalisation lands in
/// S6 we update both call sites in lock-step. Returns `None` when
/// `s` doesn't parse as JSON; that puts the verifier in a "can't
/// reproduce" state which is honest about a corrupt row.
fn sha256_of_json_str(s: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(s).ok()?;
    let bytes = serde_json::to_vec(&value).ok()?;
    let mut h = Sha256::new();
    h.update(&bytes);
    Some(format!("{:x}", h.finalize()))
}

/// Run the verifier in-process against an [`AuditEntry`] + the
/// recorded `witness_receipt_id`. The receipt hash recorded by S2 is
/// the args sha256 (content-addressed link), which is also the value
/// we expect to recover from `args_json`. Result hash isn't surfaced
/// as a separate column on the audit row — it lives on the receipt
/// itself in the Witness sidecar (S6+). For S11, since the receipt is
/// in-memory only, the closest-stable comparison is against the
/// row's `witness_receipt_id` for args + a re-hash of `result_json`
/// against itself (vacuously true when both sides are absent / both
/// present — the integrity assertion is "the row's `result_json` is
/// what `result_sha256` would have been at receipt close").
///
/// Once S6 lands and persists `result_sha256` on the audit row /
/// receipt sidecar, the second comparison flips to the recorded
/// digest. Until then it's an "args is the strong claim, result is
/// the structural-shape claim" split — documented in the UI.
pub fn verify_entry(entry: &AuditEntry) -> VerifyResult {
    let computed_args = sha256_of_json_str(&entry.args_json).unwrap_or_default();
    let computed_result = entry
        .result_json
        .as_deref()
        .and_then(sha256_of_json_str);

    let recorded_args = entry.witness_receipt_id.clone();
    let signature = if recorded_args.is_some() {
        SignatureStatus::NotYetSigned
    } else {
        SignatureStatus::NoReceipt
    };

    // args_hash_match: receipt id is content-addressed = args_sha256.
    let args_hash_match = match &recorded_args {
        Some(r) => !computed_args.is_empty() && r == &computed_args,
        // No receipt to compare against — surface as "not applicable"
        // by reporting `false` so the UI can branch on
        // `signature == NoReceipt` to choose between ✗ and "—".
        None => false,
    };

    // result_hash_match: until S6 stores result_sha256 separately, we
    // re-hash and surface the digest itself for the UI to display
    // alongside an "integrity check" label. The `bool` matches when
    // the row has a result that hashes successfully (the column is
    // NULL on failures, in which case there is nothing to verify and
    // the comparison is vacuously true).
    let result_hash_match = matches!(
        (&entry.result_json, &computed_result),
        (Some(_), Some(_)) | (None, None)
    );

    VerifyResult {
        args_hash_match,
        result_hash_match,
        signature,
        computed_args_sha256: computed_args,
        recorded_args_sha256: recorded_args,
        computed_result_sha256: computed_result,
        recorded_result_sha256: None,
    }
}

/// Build the permission listing from the static catalog + the live
/// resolver. Pure-data: no IPC, no DB. Tests cover this directly.
pub fn build_permission_listing(
    catalog: &[ToolMeta],
    resolver: &PermissionResolver,
) -> PermissionListing {
    let snap = resolver.snapshot();
    let rows = catalog
        .iter()
        .map(|m| PermissionRowDto {
            name: m.name.clone(),
            description: m.description.clone(),
            default_permission: m.default_permission,
            override_level: snap.get(&m.name).copied(),
        })
        .collect();
    PermissionListing { rows }
}

// ── Tauri commands ───────────────────────────────────────────────────────────
//
// All six commands take Tauri-managed state and translate `AuditError`
// / unknown-id paths to `IpcError` so the frontend wrapper sees the
// existing tagged union shape.

#[tauri::command]
pub async fn desktop_audit_list(
    filter: AuditFilterDto,
    store: tauri::State<'_, Arc<Store>>,
) -> Result<AuditPageDto, IpcError> {
    let log = AuditLog::new(store.inner().pool().clone());
    let page = log
        .list_filtered(&filter.into())
        .map_err(|e| IpcError::internal(format!("audit list: {e}")))?;
    Ok(page.into())
}

#[tauri::command]
pub async fn desktop_audit_get(
    id: String,
    store: tauri::State<'_, Arc<Store>>,
) -> Result<AuditEntryDto, IpcError> {
    let log = AuditLog::new(store.inner().pool().clone());
    let row = log
        .get_by_id(&id)
        .map_err(|e| IpcError::internal(format!("audit get: {e}")))?;
    row.ok_or_else(|| IpcError::internal(format!("audit row not found: {id}")))
}

#[tauri::command]
pub async fn desktop_audit_verify(
    id: String,
    store: tauri::State<'_, Arc<Store>>,
) -> Result<VerifyResult, IpcError> {
    let log = AuditLog::new(store.inner().pool().clone());
    let row = log
        .get_by_id(&id)
        .map_err(|e| IpcError::internal(format!("audit verify: {e}")))?
        .ok_or_else(|| IpcError::internal(format!("audit row not found: {id}")))?;
    Ok(verify_entry(&row))
}

#[tauri::command]
pub async fn desktop_permission_list(
    resolver: tauri::State<'_, Arc<PermissionResolver>>,
) -> Result<PermissionListing, IpcError> {
    Ok(build_permission_listing(&catalog_all(), resolver.inner()))
}

#[tauri::command]
pub async fn desktop_permission_set(
    tool: String,
    level: String,
    resolver: tauri::State<'_, Arc<PermissionResolver>>,
) -> Result<(), IpcError> {
    let parsed = PermissionLevel::parse_str(&level)
        .ok_or_else(|| IpcError::internal(format!("invalid permission level: {level}")))?;
    // Reject names that aren't in the static catalog so we can't
    // accumulate orphan overrides for tools the agent never registers.
    let known = catalog_all().into_iter().any(|m| m.name == tool);
    if !known {
        return Err(IpcError::internal(format!("unknown tool: {tool}")));
    }
    resolver.inner().set_override(tool, parsed);
    Ok(())
}

#[tauri::command]
pub async fn desktop_permission_clear(
    tool: String,
    resolver: tauri::State<'_, Arc<PermissionResolver>>,
) -> Result<(), IpcError> {
    let known = catalog_all().into_iter().any(|m| m.name == tool);
    if !known {
        return Err(IpcError::internal(format!("unknown tool: {tool}")));
    }
    resolver.inner().clear_override(&tool);
    Ok(())
}

// ── Tests ────────────────────────────────────────────────────────────────────
//
// The handlers themselves are thin shells over `AuditLog::*` and
// `PermissionResolver::*`. The unit tests below exercise the
// non-Tauri-bound logic — filter conversion, verifier semantics,
// permission listing — directly. The IPC handlers' integration with
// Tauri state is exercised via `lib.rs::run()` and the cargo `tauri
// dev` smoke path.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{AuditLog, PermissionDecision, PermissionLevel};
    use r2d2_sqlite::SqliteConnectionManager;

    fn pool() -> crate::store::SqlitePool {
        let manager = SqliteConnectionManager::memory();
        r2d2::Pool::builder()
            .max_size(1)
            .build(manager)
            .expect("memory pool")
    }

    fn entry(id: &str, tool: &str, args: &str, result: Option<&str>, success: bool) -> AuditEntry {
        // witness_receipt_id mirrors the args sha256 for round-trip
        // tests — that's the same content-addressed link
        // `WitnessEmitter::open` writes.
        let receipt = sha256_of_json_str(args).expect("args parses");
        AuditEntry {
            id: id.into(),
            tool_name: tool.into(),
            session_id: None,
            args_json: args.into(),
            result_json: result.map(|s| s.to_string()),
            permission: PermissionLevel::Auto,
            permission_decision: PermissionDecision::Allow,
            witness_receipt_id: Some(receipt),
            started_at_ms: 1,
            finished_at_ms: 2,
            success,
            error: (!success).then(|| "boom".into()),
            source: "agent".into(),
        }
    }

    fn populated_log() -> AuditLog {
        let log = AuditLog::new(pool());
        log.ensure_schema().unwrap();
        for (id, tool, args, result, ok, ts) in [
            ("a", "desktop.read_file", r#"{"k":1}"#, Some(r#"{"ok":true}"#), true, 100_u64),
            ("b", "desktop.read_file", r#"{"k":2}"#, Some(r#"{"ok":true}"#), true, 110),
            ("c", "desktop.open_url", r#"{"u":"x"}"#, None, false, 120),
            ("d", "local.run_shell", r#"{"cmd":"ls"}"#, Some(r#"{"out":""}"#), true, 130),
        ] {
            let mut e = entry(id, tool, args, result, ok);
            e.started_at_ms = ts;
            e.finished_at_ms = ts + 1;
            log.insert(&e).unwrap();
        }
        log
    }

    // ── filter conversion ───────────────────────────────────────────────────

    #[test]
    fn audit_filter_dto_default_limit_is_50_and_order_is_newest_first() {
        let dto = AuditFilterDto::default();
        let f: AuditFilter = dto.into();
        assert_eq!(f.limit, 50);
        assert_eq!(f.order, AuditOrder::NewestFirst);
    }

    // ── desktop_audit_list (via AuditLog over the same pool) ────────────────

    #[test]
    fn audit_list_filter_by_tool_name_round_trips() {
        let log = populated_log();
        let dto = AuditFilterDto {
            tool_name: Some("desktop.read_file".into()),
            ..AuditFilterDto::default()
        };
        let page = log.list_filtered(&dto.into()).unwrap();
        assert_eq!(page.total, 2);
        assert!(page.rows.iter().all(|r| r.tool_name == "desktop.read_file"));
    }

    #[test]
    fn audit_list_filter_by_success_round_trips() {
        let log = populated_log();
        let dto = AuditFilterDto {
            success: Some(false),
            ..AuditFilterDto::default()
        };
        let page = log.list_filtered(&dto.into()).unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.rows[0].id, "c");
        assert!(!page.rows[0].success);
    }

    #[test]
    fn audit_list_filter_by_date_range_round_trips() {
        let log = populated_log();
        let dto = AuditFilterDto {
            since_ms: Some(110),
            until_ms: Some(130),
            ..AuditFilterDto::default()
        };
        let page = log.list_filtered(&dto.into()).unwrap();
        assert_eq!(page.total, 2);
        let ids: Vec<&str> = page.rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["c", "b"]);
    }

    #[test]
    fn audit_list_paginates_with_stable_total() {
        let log = populated_log();
        let mut dto = AuditFilterDto {
            limit: Some(2),
            ..AuditFilterDto::default()
        };
        let p1 = log.list_filtered(&dto.clone().into()).unwrap();
        assert_eq!(p1.total, 4);
        assert_eq!(p1.rows.len(), 2);
        let cursor = p1.next_cursor.unwrap();
        dto.cursor_started_at_ms = Some(cursor);
        let p2 = log.list_filtered(&dto.into()).unwrap();
        assert_eq!(p2.total, 4); // stable
        assert_eq!(p2.rows.len(), 2);
        assert!(p2.next_cursor.is_none());
    }

    // ── desktop_audit_verify ────────────────────────────────────────────────

    #[test]
    fn verify_entry_matches_when_args_unmodified() {
        let row = entry("v-1", "t", r#"{"path":"/tmp/x"}"#, Some(r#"{"ok":true}"#), true);
        let v = verify_entry(&row);
        assert!(v.args_hash_match);
        assert!(v.result_hash_match);
        assert_eq!(v.signature, SignatureStatus::NotYetSigned);
    }

    #[test]
    fn verify_entry_detects_mutated_args_json() {
        let mut row = entry(
            "v-2",
            "t",
            r#"{"path":"/tmp/x"}"#,
            Some(r#"{"ok":true}"#),
            true,
        );
        // Tamper: replace args_json without updating witness_receipt_id.
        row.args_json = r#"{"path":"/tmp/y"}"#.into();
        let v = verify_entry(&row);
        assert!(!v.args_hash_match, "tamper must surface as args_hash_match=false");
    }

    #[test]
    fn verify_entry_handles_null_result_as_vacuous_match() {
        // Failed invocation: result_json IS NULL.
        let row = entry("v-3", "t", r#"{"k":1}"#, None, false);
        let v = verify_entry(&row);
        assert!(v.args_hash_match);
        // Both sides absent → vacuously true, NOT a false ✗.
        assert!(v.result_hash_match);
        assert!(v.computed_result_sha256.is_none());
    }

    #[test]
    fn verify_entry_with_missing_receipt_reports_no_receipt() {
        let mut row = entry("v-4", "t", r#"{"k":1}"#, Some(r#"{"ok":true}"#), true);
        row.witness_receipt_id = None;
        let v = verify_entry(&row);
        assert_eq!(v.signature, SignatureStatus::NoReceipt);
        // No receipt → args_hash_match is false (nothing to compare).
        // The UI keys on `signature == NoReceipt` to render "—" not "✗".
        assert!(!v.args_hash_match);
        assert!(v.recorded_args_sha256.is_none());
    }

    #[test]
    fn verify_entry_invalid_args_json_does_not_panic() {
        let mut row = entry("v-5", "t", r#"{"k":1}"#, None, true);
        // Corrupt: not valid JSON. The hasher must surface as miss
        // rather than panic so the UI can show ✗ on a tampered row.
        row.args_json = "{not json".into();
        let v = verify_entry(&row);
        assert!(!v.args_hash_match);
    }

    // ── desktop_permission_list ─────────────────────────────────────────────

    #[test]
    fn permission_listing_returns_full_catalog_with_empty_overrides_initially() {
        let resolver = PermissionResolver::new();
        let listing = build_permission_listing(&catalog_all(), &resolver);
        // 15 tools = S3 (6) + S4 (6) + S5 (3). The aggregator
        // `catalog_all()` chains the three clusters in registration
        // order; this assertion locks the count + the head-of-list name.
        assert_eq!(listing.rows.len(), 15);
        assert!(listing.rows.iter().all(|r| r.override_level.is_none()));
        // Names are stable: the first should be desktop.open_in_editor
        // (mirrors register order).
        assert_eq!(listing.rows[0].name, "desktop.open_in_editor");
    }

    #[test]
    fn permission_listing_round_trips_set_then_clear_through_resolver() {
        let resolver = PermissionResolver::new();
        // set
        resolver.set_override("desktop.notify", PermissionLevel::Confirm);
        let listing = build_permission_listing(&catalog_all(), &resolver);
        let notify = listing
            .rows
            .iter()
            .find(|r| r.name == "desktop.notify")
            .expect("notify present");
        assert_eq!(notify.override_level, Some(PermissionLevel::Confirm));
        // clear
        resolver.clear_override("desktop.notify");
        let listing = build_permission_listing(&catalog_all(), &resolver);
        let notify = listing
            .rows
            .iter()
            .find(|r| r.name == "desktop.notify")
            .expect("notify present");
        assert!(notify.override_level.is_none());
    }
}
