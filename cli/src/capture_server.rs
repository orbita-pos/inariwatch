use chrono::Utc;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::orchestrator::RawEvent;

const MAX_BODY_SIZE: usize = 100 * 1024; // 100 KB

pub fn start_capture_server(
    port: u16,
) -> (std::thread::JoinHandle<()>, mpsc::UnboundedReceiver<RawEvent>) {
    let (tx, rx) = mpsc::unbounded_channel();

    let handle = std::thread::spawn(move || {
        let addr = format!("0.0.0.0:{}", port);
        let server = match tiny_http::Server::http(&addr) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("  Capture server failed to bind :{} — {}", port, e);
                return;
            }
        };

        for mut request in server.incoming_requests() {
            // Only accept POST /ingest
            if request.method() != &tiny_http::Method::Post
                || request.url() != "/ingest"
            {
                let resp = tiny_http::Response::from_string("{\"error\":\"not found\"}")
                    .with_status_code(404)
                    .with_header(
                        tiny_http::Header::from_bytes(
                            &b"Content-Type"[..],
                            &b"application/json"[..],
                        )
                        .unwrap(),
                    );
                let _ = request.respond(resp);
                continue;
            }

            // Read body (capped)
            let body_len = request.body_length().unwrap_or(0);
            if body_len > MAX_BODY_SIZE {
                let resp = tiny_http::Response::from_string("{\"error\":\"body too large\"}")
                    .with_status_code(413)
                    .with_header(
                        tiny_http::Header::from_bytes(
                            &b"Content-Type"[..],
                            &b"application/json"[..],
                        )
                        .unwrap(),
                    );
                let _ = request.respond(resp);
                continue;
            }

            let mut body = String::new();
            if request.as_reader().read_to_string(&mut body).is_err() {
                let resp = tiny_http::Response::from_string("{\"error\":\"read error\"}")
                    .with_status_code(400)
                    .with_header(
                        tiny_http::Header::from_bytes(
                            &b"Content-Type"[..],
                            &b"application/json"[..],
                        )
                        .unwrap(),
                    );
                let _ = request.respond(resp);
                continue;
            }

            // Parse JSON
            let payload: Value = match serde_json::from_str(&body) {
                Ok(v) => v,
                Err(_) => {
                    let resp =
                        tiny_http::Response::from_string("{\"error\":\"invalid json\"}")
                            .with_status_code(400)
                            .with_header(
                                tiny_http::Header::from_bytes(
                                    &b"Content-Type"[..],
                                    &b"application/json"[..],
                                )
                                .unwrap(),
                            );
                    let _ = request.respond(resp);
                    continue;
                }
            };

            let title = payload["title"].as_str().unwrap_or("Captured error").to_string();
            let detail = payload["body"].as_str().unwrap_or("").to_string();
            let severity = payload["severity"].as_str().unwrap_or("critical").to_string();
            let fingerprint = payload["fingerprint"]
                .as_str()
                .unwrap_or(&title)
                .to_string();

            // Determine event type from payload: error (default), log, or deploy
            let event_type = match payload["eventType"].as_str() {
                Some("log") => "log",
                Some("deploy") => "deploy",
                _ => "runtime_error",
            };

            let integration = match event_type {
                "deploy" => "capture_deploy",
                "log" => "capture_log",
                _ => "capture",
            };

            let event = RawEvent {
                integration: integration.to_string(),
                event_type: event_type.to_string(),
                fingerprint,
                occurred_at: Utc::now(),
                payload: payload.clone(),
                severity,
                title,
                detail,
                url: None,
            };

            let _ = tx.send(event);

            let resp = tiny_http::Response::from_string("{\"ok\":true}")
                .with_status_code(200)
                .with_header(
                    tiny_http::Header::from_bytes(
                        &b"Content-Type"[..],
                        &b"application/json"[..],
                    )
                    .unwrap(),
                );
            let _ = request.respond(resp);
        }
    });

    (handle, rx)
}
