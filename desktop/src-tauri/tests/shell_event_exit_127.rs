//! Sesión 9 — a non-zero exit code (127, "command not found") is
//! preserved end-to-end through the socket and onto the bus.

use std::sync::Arc;
use std::time::Duration;

use inariwatch_desktop_lib::daemon::{start_daemon, DaemonEvent};
use inariwatch_desktop_lib::sensors::shell::{spawn_at_name, SocketName};
use inariwatch_desktop_lib::store::Store;
use tokio::io::AsyncWriteExt;

#[tokio::test]
async fn exit_code_127_propagates_to_shell_event() {
    let dir   = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open_at(&dir.path().join("store.db")).unwrap());
    let daemon = Arc::new(start_daemon());

    let rx = daemon.bus.subscribe();
    let socket_name = make_test_socket(&dir.path().to_path_buf(), "exit127");
    let _join = spawn_at_name(socket_name.clone(), daemon.clone(), store.clone());
    tokio::time::sleep(Duration::from_millis(80)).await;

    let mut conn = socket_name.connect().await.expect("client connect");
    let payload = serde_json::json!({
        "cmd":         "nope-this-doesnt-exist",
        "cwd":         "/tmp",
        "exit_code":   127,
        "duration_ms": 1,
        "timestamp":   0,
    });
    conn.write_all(format!("{}\n", payload).as_bytes()).await.unwrap();
    conn.flush().await.ok();
    tokio::time::sleep(Duration::from_millis(40)).await;
    drop(conn);

    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let mut found = false;
    while std::time::Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(150)) {
            Ok(DaemonEvent::ShellEvent { cmd, exit_code, .. }) => {
                assert_eq!(cmd, "nope-this-doesnt-exist");
                assert_eq!(exit_code, 127);
                found = true;
                break;
            }
            Ok(_)  => continue,
            Err(_) => continue,
        }
    }
    assert!(found, "exit_code 127 never observed on the bus");

    daemon.shutdown();
    Box::leak(Box::new(dir));
}

#[cfg(unix)]
fn make_test_socket(dir: &std::path::Path, name: &str) -> SocketName {
    SocketName::from_path(dir.join(format!("{name}.sock")))
}

#[cfg(windows)]
fn make_test_socket(_dir: &std::path::Path, name: &str) -> SocketName {
    SocketName::from_namespaced(format!(
        "inari-test-{name}-{}",
        uuid::Uuid::new_v4(),
    ))
}
