//! Security suite for the local-execution tool cluster (S4).
//!
//! These tests drive the **full registry pipeline** (lookup → schema
//! validate → permission gate → witness open → execute → witness
//! close → audit insert) for every "this is exactly the tool call we
//! refuse to run" path the spec calls out. The mocks live in
//! `agent::tools::local_exec::mocks` and are feature-gated behind
//! `agent-test-utils` — see this crate's `Cargo.toml`.
//!
//! What we lock here, in spec order:
//!
//! 1. `run_shell` `cmd="bash"` → SchemaInvalid (whitelist enum).
//! 2. `run_shell` `cmd="cargo"` + metacharacter argv → ExecutionFailed
//!    (backend regex catches `;`).
//! 3. `run_shell` `cmd="cargo"` + `$()` argv → ExecutionFailed.
//! 4. `run_shell` `cmd="/bin/cargo"` → SchemaInvalid. Note: spec
//!    suggests "ExecutionFailed (path separator)" but the schema's
//!    enum on `cmd` already rejects anything outside the literal
//!    whitelist, so the registry short-circuits before the backend's
//!    path-separator guard fires. Both layers exist (defence in
//!    depth); the path-separator guard is exercised directly in the
//!    `local_exec::tests::validate_program_*` lib unit tests.
//! 5. `run_shell` `cwd="../../../etc"` → ExecutionFailed (cwd outside
//!    workspace).
//! 6. `read_file` absolute path outside the workspace → ExecutionFailed.
//! 7. `read_file` with `..` segments escaping the workspace →
//!    ExecutionFailed.
//! 8. `read_file` following a symlink that points outside the
//!    workspace → ExecutionFailed.
//! 9. `write_file` refuses to overwrite when the destination is a
//!    symlink.
//! 10. `write_file` content > 10 MB → ExecutionFailed.
//! 11. `run_test` pattern containing `--` → SchemaInvalid.
//! 12. End-to-end happy path through every tool — registry runs to
//!     completion, exactly one audit row + one receipt with
//!     `success = true`.
//! 13. `register_local_exec_tools` registers exactly six tools
//!     without name collisions.

#![cfg(feature = "agent-test-utils")]

use std::path::PathBuf;
use std::sync::Arc;

use inariwatch_desktop_lib::agent::tools::local_exec::{
    catalog as local_exec_catalog,
    mocks::{mock_backends, GitCall},
    register_local_exec_tools, sandbox, FsBackend, ShellOutput,
};
use inariwatch_desktop_lib::agent::tools::{
    GitDiffTool, GitStatusTool, LocalExecBackends, ReadFileTool, RunShellTool, RunTestTool,
    WriteFileTool,
};
use inariwatch_desktop_lib::agent::{
    AuditLog, ChatTool, InMemoryReceiptSink, PermissionLevel, PermissionResolver, RegistryError,
    ToolError, ToolMeta, ToolRegistry, WitnessEmitter,
};
use r2d2_sqlite::SqliteConnectionManager;
use serde_json::json;

const WS_ROOT: &str = "/ws/repo";

fn ws_root() -> PathBuf {
    PathBuf::from(WS_ROOT)
}

struct Rig {
    reg: ToolRegistry,
    sink: Arc<InMemoryReceiptSink>,
    audit: Arc<AuditLog>,
    shell: Arc<inariwatch_desktop_lib::agent::tools::local_exec::mocks::MockShellBackend>,
    fs: Arc<inariwatch_desktop_lib::agent::tools::local_exec::mocks::MockFsBackend>,
    git: Arc<inariwatch_desktop_lib::agent::tools::local_exec::mocks::MockGitBackend>,
}

fn rig() -> Rig {
    let pool = r2d2::Pool::builder()
        .max_size(1)
        .build(SqliteConnectionManager::memory())
        .expect("memory pool");
    let audit = Arc::new(AuditLog::new(pool));
    audit.ensure_schema().expect("ensure schema");
    let sink = Arc::new(InMemoryReceiptSink::new(64));
    let witness = Arc::new(WitnessEmitter::new(sink.clone()));
    let resolver = Arc::new(PermissionResolver::new());
    let reg = ToolRegistry::new(resolver, witness, audit.clone());

    let (bundle, shell, fs, git) = mock_backends(ws_root());
    register_local_exec_tools(&reg, bundle).expect("register");

    Rig {
        reg,
        sink,
        audit,
        shell,
        fs,
        git,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. run_shell cmd="bash" → SchemaInvalid (whitelist enum)
// ─────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn run_shell_rejects_unwhitelisted_program_at_schema_level() {
    let r = rig();
    let err = r
        .reg
        .invoke_confirmed("local.run_shell", json!({ "cmd": "bash" }), None)
        .await
        .expect_err("must reject");
    assert!(
        matches!(err, RegistryError::SchemaInvalid(_)),
        "unexpected: {err:?}"
    );
    assert!(r.shell.calls().is_empty(), "backend must not have run");
    let row = r.audit.list_recent(1).unwrap().pop().unwrap();
    assert!(!row.success);
    assert!(row.error.unwrap().contains("schema invalid"));
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. run_shell cmd="cargo" args=["test", ";", "rm", "-rf", "/"] → ExecutionFailed
// ─────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn run_shell_rejects_metacharacter_in_argv_at_backend() {
    let r = rig();
    let err = r
        .reg
        .invoke_confirmed(
            "local.run_shell",
            json!({ "cmd": "cargo", "args": ["test", ";", "rm", "-rf", "/"] }),
            None,
        )
        .await
        .expect_err("must reject");
    match err {
        RegistryError::Tool(ToolError::ExecutionFailed(m)) => {
            assert!(
                m.contains("metacharacter"),
                "expected metacharacter rejection, got: {m}"
            );
        }
        other => panic!("expected Tool(ExecutionFailed), got {other:?}"),
    }
    assert!(r.shell.calls().is_empty(), "backend must not have run");
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. run_shell cmd="cargo" args=["$(whoami)"] → ExecutionFailed
// ─────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn run_shell_rejects_command_substitution_argv() {
    let r = rig();
    let err = r
        .reg
        .invoke_confirmed(
            "local.run_shell",
            json!({ "cmd": "cargo", "args": ["$(whoami)"] }),
            None,
        )
        .await
        .expect_err("must reject");
    assert!(matches!(
        err,
        RegistryError::Tool(ToolError::ExecutionFailed(_))
    ));
    assert!(r.shell.calls().is_empty());
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. run_shell cmd="/bin/cargo" → SchemaInvalid (whitelist enum rejects)
//    [Spec wording suggested ExecutionFailed; the schema enum
//     short-circuits first. The backend path-separator guard is
//     exercised directly in the lib unit tests.]
// ─────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn run_shell_rejects_absolute_path_in_cmd() {
    let r = rig();
    let err = r
        .reg
        .invoke_confirmed(
            "local.run_shell",
            json!({ "cmd": "/bin/cargo", "args": [] }),
            None,
        )
        .await
        .expect_err("must reject");
    assert!(
        matches!(err, RegistryError::SchemaInvalid(_)),
        "unexpected: {err:?}"
    );
    assert!(r.shell.calls().is_empty(), "backend must not have run");
}

#[test]
fn validate_program_guards_path_separators_directly() {
    // Defence-in-depth pair test for the case above: even if a
    // future patch loosened the schema's enum, the backend guard
    // would still reject paths in cmd.
    assert!(sandbox::validate_program("/bin/cargo").is_err());
    assert!(sandbox::validate_program("C:\\foo\\cargo.exe").is_err());
    assert!(sandbox::validate_program("..\\cargo").is_err());
    assert!(sandbox::validate_program("cargo").is_ok());
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. run_shell cwd="../../../etc" → ExecutionFailed (cwd outside workspace)
// ─────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn run_shell_rejects_cwd_outside_workspace() {
    let r = rig();
    // Pre-register the escaped path as a directory so canonicalize
    // *succeeds*; the rejection has to come from the
    // `path_is_within(workspace_root)` check, not from a missing
    // entry. That nails down which guard is doing the work.
    r.fs.add_dir(PathBuf::from("/etc"));

    let err = r
        .reg
        .invoke_confirmed(
            "local.run_shell",
            json!({ "cmd": "cargo", "args": [], "cwd": "../../../etc" }),
            None,
        )
        .await
        .expect_err("must reject");
    match err {
        RegistryError::Tool(ToolError::ExecutionFailed(m)) => {
            assert!(
                m.contains("escapes workspace"),
                "expected escape rejection, got: {m}"
            );
        }
        other => panic!("expected Tool(ExecutionFailed), got {other:?}"),
    }
    assert!(r.shell.calls().is_empty(), "backend must not have run");
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. read_file absolute path outside WS → ExecutionFailed
// ─────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn read_file_rejects_absolute_path_outside_workspace() {
    let r = rig();
    // Register the target so canonicalize succeeds — the rejection
    // must come from the workspace containment check.
    r.fs.add_file(PathBuf::from("/etc/passwd"), b"root:x:0:0".to_vec());
    let err = r
        .reg
        .invoke_confirmed(
            "local.read_file",
            json!({ "path": "/etc/passwd" }),
            None,
        )
        .await
        .expect_err("must reject");
    match err {
        RegistryError::Tool(ToolError::ExecutionFailed(m)) => {
            assert!(
                m.contains("escapes workspace"),
                "expected escape rejection, got: {m}"
            );
        }
        other => panic!("expected Tool(ExecutionFailed), got {other:?}"),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. read_file with ".." segments escaping WS → ExecutionFailed
// ─────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn read_file_rejects_dotdot_traversal() {
    let r = rig();
    r.fs.add_file(PathBuf::from("/etc/passwd"), b"root:x:0:0".to_vec());
    let err = r
        .reg
        .invoke_confirmed(
            "local.read_file",
            json!({ "path": "../../etc/passwd" }),
            None,
        )
        .await
        .expect_err("must reject");
    match err {
        RegistryError::Tool(ToolError::ExecutionFailed(m)) => {
            assert!(
                m.contains("escapes workspace"),
                "expected escape rejection, got: {m}"
            );
        }
        other => panic!("expected Tool(ExecutionFailed), got {other:?}"),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. read_file following a symlink that points outside WS → ExecutionFailed
// ─────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn read_file_rejects_symlink_pointing_outside_workspace() {
    let r = rig();
    // Symlink lives inside the workspace ...
    r.fs.add_symlink(
        ws_root().join("link.txt"),
        PathBuf::from("/etc/passwd"),
    );
    // ... but its target is outside.
    r.fs.add_file(PathBuf::from("/etc/passwd"), b"root:x:0:0".to_vec());

    let err = r
        .reg
        .invoke_confirmed(
            "local.read_file",
            json!({ "path": "link.txt" }),
            None,
        )
        .await
        .expect_err("must reject");
    match err {
        RegistryError::Tool(ToolError::ExecutionFailed(m)) => {
            assert!(
                m.contains("escapes workspace"),
                "expected escape rejection (canonicalize follows the link), got: {m}"
            );
        }
        other => panic!("expected Tool(ExecutionFailed), got {other:?}"),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. write_file refuses to overwrite a symlink destination
// ─────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn write_file_refuses_to_overwrite_symlink_destination() {
    let r = rig();
    // Destination IS a symlink — even if its target lives inside the
    // workspace, we refuse the write so a malicious link planted
    // earlier can't redirect future writes.
    r.fs.add_symlink(
        ws_root().join("attacker.txt"),
        ws_root().join("legit.txt"),
    );
    r.fs.add_file(ws_root().join("legit.txt"), b"old".to_vec());

    let err = r
        .reg
        .invoke_confirmed(
            "local.write_file",
            json!({ "path": "attacker.txt", "content": "new" }),
            None,
        )
        .await
        .expect_err("must reject");
    match err {
        RegistryError::Tool(ToolError::ExecutionFailed(m)) => {
            assert!(
                m.contains("symlink"),
                "expected symlink-overwrite rejection, got: {m}"
            );
        }
        other => panic!("expected Tool(ExecutionFailed), got {other:?}"),
    }
    // No write must have happened.
    assert!(
        r.fs.writes().is_empty(),
        "no writes must reach the backend on rejection"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. write_file content > 10 MB → ExecutionFailed before the write
// ─────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn write_file_rejects_content_above_10mb_cap() {
    let r = rig();
    // Build a string just over the 10 MB cap.
    let big = "a".repeat(sandbox::WRITE_FILE_MAX + 1);
    let err = r
        .reg
        .invoke_confirmed(
            "local.write_file",
            json!({ "path": "huge.txt", "content": big }),
            None,
        )
        .await
        .expect_err("must reject");
    match err {
        RegistryError::Tool(ToolError::ExecutionFailed(m)) => {
            assert!(
                m.contains("10485760") || m.contains("more than"),
                "expected size rejection, got: {m}"
            );
        }
        other => panic!("expected Tool(ExecutionFailed), got {other:?}"),
    }
    assert!(r.fs.writes().is_empty(), "no write reaches backend");
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. run_test pattern containing "--" → SchemaInvalid
// ─────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn run_test_rejects_double_dash_at_schema_level() {
    let r = rig();
    let err = r
        .reg
        .invoke_confirmed(
            "local.run_test",
            json!({ "pattern": "x -- --include-ignored" }),
            None,
        )
        .await
        .expect_err("must reject");
    assert!(
        matches!(err, RegistryError::SchemaInvalid(_)),
        "unexpected: {err:?}"
    );
    assert!(r.shell.calls().is_empty());
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. End-to-end happy path through every tool
// ─────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn happy_path_run_shell_audits_one_success_row() {
    let r = rig();
    r.shell.set_response(ShellOutput {
        stdout: "v1.2.3".into(),
        stderr: String::new(),
        exit_code: Some(0),
        timed_out: false,
        stdout_total_bytes: 6,
        stderr_total_bytes: 0,
    });
    let out = r
        .reg
        .invoke_confirmed(
            "local.run_shell",
            json!({ "cmd": "cargo", "args": ["--version"] }),
            Some("session-1".into()),
        )
        .await
        .expect("ok");
    assert_eq!(out.value["ok"], json!(true));
    assert_eq!(out.value["stdout"], json!("v1.2.3"));

    assert_eq!(r.sink.len(), 1);
    let row = r.audit.list_recent(1).unwrap().pop().unwrap();
    assert!(row.success);
    assert_eq!(row.tool_name, "local.run_shell");
    assert_eq!(row.permission, PermissionLevel::Confirm);
    assert!(row.witness_receipt_id.is_some());
}

#[tokio::test]
async fn happy_path_read_file_audits_one_success_row() {
    let r = rig();
    r.fs.add_file(ws_root().join("hi.txt"), b"hello".to_vec());
    let out = r
        .reg
        .invoke("local.read_file", json!({ "path": "hi.txt" }), None)
        .await
        .expect("ok");
    assert_eq!(out.value["content"], json!("hello"));
    assert_eq!(r.sink.len(), 1);
    let row = r.audit.list_recent(1).unwrap().pop().unwrap();
    assert!(row.success);
    assert_eq!(row.permission, PermissionLevel::Auto);
}

#[tokio::test]
async fn happy_path_write_file_audits_one_success_row() {
    let r = rig();
    let out = r
        .reg
        .invoke_confirmed(
            "local.write_file",
            json!({ "path": "out.txt", "content": "hello" }),
            None,
        )
        .await
        .expect("ok");
    assert_eq!(out.value["bytes"], json!(5));
    let writes = r.fs.writes();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].1, b"hello");
    let row = r.audit.list_recent(1).unwrap().pop().unwrap();
    assert!(row.success);
}

#[tokio::test]
async fn happy_path_run_test_audits_one_success_row() {
    let r = rig();
    r.shell.set_response(ShellOutput {
        stdout: "ok".into(),
        stderr: String::new(),
        exit_code: Some(0),
        timed_out: false,
        stdout_total_bytes: 2,
        stderr_total_bytes: 0,
    });
    let out = r
        .reg
        .invoke_confirmed(
            "local.run_test",
            json!({ "pattern": "agent::tools::local_exec" }),
            None,
        )
        .await
        .expect("ok");
    assert_eq!(out.value["ok"], json!(true));
    let calls = r.shell.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].cmd, "cargo");
    assert_eq!(
        calls[0].args,
        vec!["test".to_string(), "agent::tools::local_exec".to_string()]
    );
    let row = r.audit.list_recent(1).unwrap().pop().unwrap();
    assert!(row.success);
    assert_eq!(row.tool_name, "local.run_test");
}

#[tokio::test]
async fn happy_path_git_status_audits_one_success_row() {
    let r = rig();
    r.git.set_response(ShellOutput {
        stdout: " M README.md\n".into(),
        stderr: String::new(),
        exit_code: Some(0),
        timed_out: false,
        stdout_total_bytes: 13,
        stderr_total_bytes: 0,
    });
    let out = r
        .reg
        .invoke("local.git_status", json!({}), None)
        .await
        .expect("ok");
    assert_eq!(out.value["stdout"], json!(" M README.md\n"));
    let calls = r.git.calls();
    assert_eq!(calls.len(), 1);
    match &calls[0] {
        GitCall::Status { cwd, .. } => assert_eq!(cwd, &ws_root()),
        other => panic!("expected Status, got {other:?}"),
    }
    let row = r.audit.list_recent(1).unwrap().pop().unwrap();
    assert!(row.success);
    assert_eq!(row.permission, PermissionLevel::Auto);
}

#[tokio::test]
async fn happy_path_git_diff_audits_one_success_row() {
    let r = rig();
    r.fs.add_file(ws_root().join("src/main.rs"), b"// hi".to_vec());
    r.git.set_response(ShellOutput {
        stdout: "diff --git a b".into(),
        stderr: String::new(),
        exit_code: Some(0),
        timed_out: false,
        stdout_total_bytes: 14,
        stderr_total_bytes: 0,
    });
    let out = r
        .reg
        .invoke(
            "local.git_diff",
            json!({ "staged": true, "path": "src/main.rs" }),
            None,
        )
        .await
        .expect("ok");
    assert_eq!(out.value["ok"], json!(true));
    let calls = r.git.calls();
    assert_eq!(calls.len(), 1);
    match &calls[0] {
        GitCall::Diff {
            cwd, staged, path, ..
        } => {
            assert_eq!(cwd, &ws_root());
            assert!(*staged);
            assert_eq!(path, &Some(ws_root().join("src/main.rs")));
        }
        other => panic!("expected Diff, got {other:?}"),
    }
    let row = r.audit.list_recent(1).unwrap().pop().unwrap();
    assert!(row.success);
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. register_local_exec_tools registers exactly six distinct tools
// ─────────────────────────────────────────────────────────────────────────────
#[test]
fn register_local_exec_tools_registers_six_without_collision() {
    let r = rig();
    let metas = r.reg.list();
    assert_eq!(metas.len(), 6, "expected six tools, got {}", metas.len());
    let names: std::collections::HashSet<_> =
        metas.iter().map(|m| m.name.as_str()).collect();
    for expected in [
        "local.run_shell",
        "local.read_file",
        "local.write_file",
        "local.run_test",
        "local.git_status",
        "local.git_diff",
    ] {
        assert!(names.contains(expected), "missing tool {expected}");
    }
}

#[test]
fn register_local_exec_tools_advertises_expected_default_permissions() {
    let r = rig();
    let by_name: std::collections::HashMap<_, _> = r
        .reg
        .list()
        .into_iter()
        .map(|m| (m.name.clone(), m.default_permission))
        .collect();
    assert_eq!(by_name["local.run_shell"], PermissionLevel::Confirm);
    assert_eq!(by_name["local.read_file"], PermissionLevel::Auto);
    assert_eq!(by_name["local.write_file"], PermissionLevel::Confirm);
    assert_eq!(by_name["local.run_test"], PermissionLevel::Confirm);
    assert_eq!(by_name["local.git_status"], PermissionLevel::Auto);
    assert_eq!(by_name["local.git_diff"], PermissionLevel::Auto);
}

// Locks `local_exec::catalog()` against drift from what
// `register_local_exec_tools` actually registers. S11's `catalog_all`
// aggregator reads `catalog()`; if the duplicated metadata drifts, the
// settings UI silently shows stale schemas.
#[test]
fn catalog_matches_registered_tool_metas() {
    let r = rig();
    let registered: std::collections::HashMap<String, ToolMeta> = r
        .reg
        .list()
        .into_iter()
        .map(|m| (m.name.clone(), m))
        .collect();
    let catalog_metas = local_exec_catalog();
    assert_eq!(
        catalog_metas.len(),
        6,
        "catalog must list 6 local exec tools, got {}",
        catalog_metas.len()
    );
    for cat in &catalog_metas {
        let reg_meta = registered
            .get(&cat.name)
            .unwrap_or_else(|| panic!("catalog name {} not in registered", cat.name));
        assert_eq!(cat.name, reg_meta.name, "name drift for {}", cat.name);
        assert_eq!(
            cat.description, reg_meta.description,
            "description drift for {}",
            cat.name
        );
        assert_eq!(
            cat.params_schema, reg_meta.params_schema,
            "schema drift for {}",
            cat.name
        );
        assert_eq!(
            cat.default_permission, reg_meta.default_permission,
            "permission drift for {}",
            cat.name
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Backend failure → ExecutionFailed is preserved on the audit row
// ─────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn backend_failure_audits_failure_row_with_message_preserved() {
    let r = rig();
    r.shell.fail_next("spawn cargo: not found");
    let err = r
        .reg
        .invoke_confirmed(
            "local.run_shell",
            json!({ "cmd": "cargo", "args": ["test"] }),
            None,
        )
        .await
        .expect_err("must fail");
    match err {
        RegistryError::Tool(inner) => {
            assert!(format!("{inner}").contains("spawn cargo: not found"));
        }
        other => panic!("expected Tool error, got {other:?}"),
    }
    let row = r.audit.list_recent(1).unwrap().pop().unwrap();
    assert!(!row.success);
    assert!(row.error.unwrap().contains("spawn cargo: not found"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Direct constructor smoke: build the tools without the registry, drive
// them through `execute()`, sanity check meta. Belt-and-suspenders for
// the case where the registry harness changes shape.
// ─────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn direct_construction_each_tool_has_expected_meta() {
    let (bundle, _shell, _fs, _git) = mock_backends(ws_root());
    let LocalExecBackends {
        workspace_root,
        shell,
        fs,
        git,
    } = bundle;
    let run_shell = RunShellTool::new(workspace_root.clone(), shell.clone(), fs.clone());
    let read_file = ReadFileTool::new(workspace_root.clone(), fs.clone());
    let write_file = WriteFileTool::new(workspace_root.clone(), fs.clone());
    let run_test = RunTestTool::new(workspace_root.clone(), shell);
    let git_status = GitStatusTool::new(workspace_root.clone(), git.clone());
    let git_diff = GitDiffTool::new(workspace_root, git, fs);

    assert_eq!(run_shell.meta().name, "local.run_shell");
    assert_eq!(read_file.meta().name, "local.read_file");
    assert_eq!(write_file.meta().name, "local.write_file");
    assert_eq!(run_test.meta().name, "local.run_test");
    assert_eq!(git_status.meta().name, "local.git_status");
    assert_eq!(git_diff.meta().name, "local.git_diff");
}

// Sanity check: the FsBackend trait is the seam we tested through, so
// a quick "the mock FS canonicalize follows symlinks back into the WS
// when the link target is also inside" guard sits here. This is what
// makes the read_file negative test meaningful — the same mock would
// happily return the bytes when the link stays inside.
#[tokio::test]
async fn mock_fs_canonicalize_resolves_in_workspace_symlinks() {
    let r = rig();
    r.fs.add_file(ws_root().join("real.txt"), b"hi".to_vec());
    r.fs.add_symlink(ws_root().join("link.txt"), ws_root().join("real.txt"));

    let resolved = r.fs.canonicalize(&ws_root().join("link.txt"));
    assert_eq!(resolved.expect("ok"), ws_root().join("real.txt"));
}
