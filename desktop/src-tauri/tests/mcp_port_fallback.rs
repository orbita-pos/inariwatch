//! Port fallback policy: if the configured / default port is taken,
//! `bind_with_fallback` walks `9876..=9891` and returns the first that
//! succeeds. Hot-paths the explicit `requested` argument first.

use std::net::{SocketAddr, TcpListener};

use inariwatch_desktop_lib::sensors::mcp::transport_http::{
    bind_with_fallback, DEFAULT_PORT, MAX_FALLBACK,
};

#[test]
fn first_attempt_succeeds_when_port_free() {
    // Use an ephemeral port so we don't fight the user's running daemon.
    let scratch = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).unwrap();
    let chosen  = scratch.local_addr().unwrap().port();
    drop(scratch);
    let (sock, port) = bind_with_fallback(Some(chosen)).unwrap();
    assert_eq!(port, chosen);
    drop(sock);
}

#[test]
fn falls_through_to_next_when_default_taken() {
    // Hold DEFAULT_PORT (9876) so the resolver has to fall through.
    // The block below may itself fail to bind (the user might have
    // something running on 9876 already in CI). We treat that case
    // as "test inconclusive" rather than failing — the production
    // resolver will have walked the same range.
    let blocker = match TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], DEFAULT_PORT))) {
        Ok(l) => l,
        Err(_) => {
            eprintln!("DEFAULT_PORT already in use — skipping fallback assertion");
            return;
        }
    };
    let (sock, port) = bind_with_fallback(None).unwrap();
    assert!(
        port > DEFAULT_PORT && port <= MAX_FALLBACK,
        "expected fallback port in ({DEFAULT_PORT}, {MAX_FALLBACK}], got {port}"
    );
    drop(sock);
    drop(blocker);
}

#[test]
fn requested_port_is_tried_first() {
    let scratch = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).unwrap();
    let target  = scratch.local_addr().unwrap().port();
    drop(scratch);
    let (sock, port) = bind_with_fallback(Some(target)).unwrap();
    assert_eq!(port, target, "explicit `requested` should be honoured");
    drop(sock);
}
