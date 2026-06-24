# inari-relay

WS relay for InariWatch's AI router (v0.3 S2).

Per `INARI_AI_ARCHITECTURE.md` §4 (LOCKED 2026-05-02), this service lets
the InariWatch cloud dispatch AI tasks to the user's local Inari Live
sidecar over a long-lived WebSocket. Hosted on Hetzner alongside the
existing Go staging server (:9400) and Node.js worker (:9401).

## Endpoints

| Method | Path                   | Auth                      | Purpose                                                      |
| ------ | ---------------------- | ------------------------- | ------------------------------------------------------------ |
| GET    | `/health`              | none                      | Liveness probe (count of online users + server time).        |
| GET    | `/ws`                  | JWT (HS256, `sub`=user_id) | WebSocket upgrade — Inari Live sidecar registration channel. |
| POST   | `/dispatch`            | `RELAY_DISPATCH_SECRET`   | Server→server forward of `{ user_id, task, payload }`.       |
| GET    | `/admin/connections`   | `RELAY_DISPATCH_SECRET`   | Snapshot of online users for the `/admin/ops` widget.        |

## Frame protocol (over `/ws`)

After the WS handshake completes, the client (Inari Live) MUST send a
`register` frame as the first message. Subsequent frames travel in both
directions.

| Direction       | `type`     | Body                                                                            |
| --------------- | ---------- | ------------------------------------------------------------------------------- |
| client → server | `register` | `{ capabilities: ["notify.compose.*", ...], app_version, os, arch }`             |
| server → client | `ack`      | `{ status: "registered" }` — sent once, in response to the first valid register. |
| server → client | `dispatch` | `{ request_id, task, payload, timeout_ms? }`                                    |
| client → server | `response` | `{ request_id, status: "ok"\|"error", body?, receipt?, error? }`                |

Heartbeat is handled by gorilla/websocket's built-in ping/pong. The
server sends a ping every 30s; if no pong arrives within 60s the
connection is dropped and `register` must be re-sent on reconnect.

## Build

```bash
go build -o inari-relay .
```

No CGO. Single static binary. Cross-compile with the standard toolchain:

```bash
GOOS=linux GOARCH=amd64 go build -o inari-relay-linux-amd64 .
```

## Test

```bash
go test ./...
```

19 tests covering JWT auth, dispatch routing, fallback on disconnect /
timeout, admin endpoint, malformed-token rejection.

## Deploy (NOT done in S2 — code-only)

Real deploy happens in a follow-up — Jesus drives it with kamal/rsync.
For reference once that day comes:

1. `rsync` the binary to `/opt/inari-relay/inari-relay`.
2. Drop the systemd unit at `/etc/systemd/system/inari-relay.service`
   and the env at `/opt/inari-relay/.env`.
3. Append `deploy/caddy.snippet` to the existing Caddyfile and
   `caddy reload`.
4. `systemctl enable --now inari-relay`.
5. Smoke: `curl -s https://relay.inariwatch.com/health`.

## Privacy commitment (per architecture §4.5)

- Relay sees: task type, payload size, dispatch timestamp, response
  timestamp.
- Relay does NOT see: payload contents (E2E encryption deferred to
  Phase 4 if WS framing budget allows — §13.1).
- Caddy access logs are JSON; **request bodies are never logged**.
