//! Sesión 9 — sending one valid JSON line over the socket produces a
//! `DaemonEvent::ShellEvent` on the bus with the expected fields.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use inariwatch_desktop_lib::daemon::{start_daemon, DaemonEvent};
use inariwatch_desktop_lib::sensors::shell::{spawn_at_name, SocketName};
use inariwatch_desktop_lib::store::Store;
use tokio::io::AsyncWriteExt;

#[tokio::test]
async fn roundtrip_emits_shell_event_with_fields() {
    let dir   = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open_at(&dir.path().join("store.db")).unwrap());
    let daemon = Arc::new(start_daemon());

    // Subscribe BEFORE we connect so we don't race the publish.
    let rx = daemon.bus.subscribe();

    let socket_name = make_test_socket(&dir.path().to_path_buf(), "roundtrip");
    let _join = spawn_at_name(socket_name.clone(), daemon.clone(), store.clone());

    // Listener spawn is async — give the bind a moment.
    tokio::time::sleep(Duration::from_millis(80)).await;

    let mut conn = socket_name
        .connect()
        .await
        .expect("client connect to test socket");

    let payload = serde_json::json!({
        "cmd":         "ls /tmp",
        "cwd":         "/tmp",
        "exit_code":   0,
        "duration_ms": 5,
        "timestamp":   0,
    });
    let line = format!("{}\n", payload);
    conn.write_all(line.as_bytes()).await.unwrap();
    conn.flush().await.ok();
    // Hold the connection long enough for the daemon to drain the
    // line. Closing immediately is fine; we just don't close before
    // the write reached the kernel.
    tokio::time::sleep(Duration::from_millis(40)).await;
    drop(conn);

    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let mut found = false;
    while std::time::Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(150)) {
            Ok(DaemonEvent::ShellEvent { cmd, cwd, exit_code, duration_ms, .. }) => {
                assert_eq!(cmd, "ls /tmp");
                assert_eq!(cwd, PathBuf::from("/tmp"));
                assert_eq!(exit_code, 0);
                assert_eq!(duration_ms, 5);
                found = true;
                break;
            }
            Ok(_)  => continue,
            Err(_) => continue,
        }
    }
    assert!(found, "ShellEvent never published after roundtrip");

    daemon.shutdown();
    // Defensive: don't let the tempdir drop before the listener task
    // notices shutdown — tempfile cleanup races a still-bound socket.
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
