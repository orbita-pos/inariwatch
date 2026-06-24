# InariWatch Peer Protocol Specification v1

> **Handoff document.** Wire protocol between InariWatch cloud (server) and `@inariwatch/capture` SDK (client). This spec is **open**. Anyone can implement a client SDK in any runtime that conforms to this protocol.
>
> **Read with:** `REMEDIATION_SYSTEM_ARCHITECTURE.md`, `SDK_PEER_ARCHITECTURE.md`, `SECURITY_AND_COMPLIANCE_ROADMAP.md`.
>
> **Protocol version:** 1.0
> **Status:** Design freeze candidate. Breaking changes after freeze require version bump to 2.0.
> **License:** MIT. Spec document under CC-BY 4.0.
> **Date:** 2026-04-22

---

## 0. Design principles

1. **Simplicity over elegance.** JSON over WebSocket. No custom binary format. Every field human-readable.
2. **Forward compatible.** Unknown fields ignored by both sides. Version negotiation on handshake.
3. **Authenticated by default.** Every meaningful message signed. No implicit trust.
4. **Stateless on the wire.** Each message is self-contained; no shared state assumption between server and client.
5. **Observable.** Every message has a correlation ID usable in both audit logs.
6. **No RPC magic.** Structured messages, not hidden method dispatch. Implementations are easy to audit.

---

## 1. Transport

### 1.1 Preferred — WebSocket over TLS

- Endpoint: `wss://peer.inariwatch.com/v1/connect`
- Subprotocol: `inariwatch-peer.v1`
- Bearer token in header: `Authorization: Bearer <subscription-jwt>`
- Ping/pong per RFC 6455 every 30s

### 1.2 Fallback — Server-Sent Events + POST

For clients behind firewalls blocking WebSocket:
- Inbound (server→client): `GET /v1/events` with `Accept: text/event-stream`
- Outbound (client→server): `POST /v1/events` with JSON body
- Clients must retry with exponential backoff on disconnect

### 1.3 Last resort — Long polling

For extremely restricted environments:
- `GET /v1/poll?cursor=<last-seen-id>` returns up to 10 pending messages or blocks up to 25s
- `POST /v1/send` for outbound
- Implementations must set `Cache-Control: no-store`

### 1.4 Heartbeat

All transports require bidirectional heartbeat every 30s. Absence of heartbeat for 90s → transport considered dead, client reconnects.

---

## 2. Message envelope

Every message, regardless of direction or transport, has this shape:

```jsonc
{
  "v": "1.0",                            // protocol version
  "id": "msg_01HGW...",                  // ULID; unique per message
  "correlation_id": "msg_01HGW..." | null, // reply linkage
  "type": "command|response|event|heartbeat|handshake|error",
  "ts": "2026-04-22T15:30:00.000Z",      // ISO 8601 UTC
  "payload": { ... },                    // type-specific
  "signature": "base64-ed25519" | null   // required on commands from server; optional on events
}
```

### 2.1 Signature scheme

- Algorithm: **Ed25519** (RFC 8032)
- Signed bytes: deterministic JSON serialization of `{ v, id, correlation_id, type, ts, payload }` (signature field excluded from signing input)
- Canonicalization: JCS (RFC 8785) — sort object keys lexicographically, no whitespace
- Server signs all `command` and `handshake` messages. Client signs `response` and `handshake`.
- `event` messages from client may be unsigned (observability data, not actionable); `event` messages from server are always signed.

### 2.2 Signature verification

On each inbound message:
1. Verify `v` is compatible
2. Verify signature against known pubkey (baked + TOFU chain)
3. Verify `ts` is within ±5 minutes of local clock (replay protection)
4. Verify `id` not seen in last 1 hour (replay protection; sliding window bloom filter)
5. Process payload

Any failure → discard message, log to local audit as `REJECTED_SIGNATURE` with details.

---

## 3. Handshake

### 3.1 Initial handshake (client → server, right after transport open)

```jsonc
{
  "v": "1.0",
  "id": "msg_...",
  "type": "handshake",
  "ts": "...",
  "payload": {
    "sdk_name": "@inariwatch/capture",
    "sdk_version": "2.0.0",
    "runtime": "node",
    "runtime_version": "20.12.0",
    "os": "linux",
    "capabilities": ["read_file", "read_runtime_var", "get_git_state"],
    "subscription_tier": null,           // server determines from token
    "policy_hash": "sha256:...",         // fingerprint of loaded .inariwatch/policy.yml
    "machine_id": "sha256:..."           // stable per-machine identifier (no PII)
  },
  "signature": "..."                     // signed with ephemeral key generated on startup
}
```

### 3.2 Handshake response (server → client)

```jsonc
{
  "v": "1.0",
  "id": "msg_...",
  "correlation_id": "<client handshake id>",
  "type": "handshake",
  "ts": "...",
  "payload": {
    "accepted": true,
    "session_id": "sess_01HGW...",
    "cloud_pubkey": "base64-ed25519",    // current cloud signing pubkey
    "cloud_pubkey_chain": [              // chain for rotation verification
      { "pubkey": "...", "signed_by": "...", "signature": "..." }
    ],
    "subscription_tier": "pro",          // "free" | "pro" | "enterprise"
    "enabled_capabilities": [...],        // intersection of client caps + tier grants
    "heartbeat_interval_s": 30,
    "policy_ack": "accepted"             // or "policy_too_permissive" with details
  },
  "signature": "..."
}
```

### 3.3 Handshake failure

```jsonc
{
  "type": "error",
  "payload": {
    "code": "INVALID_TOKEN" | "EXPIRED_TOKEN" | "VERSION_INCOMPATIBLE" | "SIGNATURE_INVALID" | "POLICY_REJECTED",
    "message": "human-readable reason",
    "retry_after_s": 30 | null
  }
}
```

### 3.4 Ephemeral key lifecycle

- Client generates ephemeral Ed25519 keypair on SDK init
- Public key included in handshake
- Server issues session-bound certificate signing this ephemeral pubkey with cloud key
- Valid for duration of session (max 4 hours; renewed on each heartbeat if still active)
- Ephemeral key rotated on reconnect

---

## 4. Commands (server → client)

### 4.1 Command envelope

```jsonc
{
  "v": "1.0",
  "id": "cmd_...",
  "type": "command",
  "ts": "...",
  "payload": {
    "tool": "read_file",               // must be in enabled_capabilities
    "arguments": { ... },               // tool-specific
    "policy_hint": { ... },             // optional — server's view of what policy allows
    "timeout_ms": 5000,                 // client should respect; hard max 60_000
    "requires_user_confirm": false,     // if true, client must surface to user and wait
    "audit_context": {                  // goes into audit log
      "session_id": "sess_...",
      "remediation_id": "rem_...",
      "reason": "Tier 2 sub-agent H1 exploring null check hypothesis"
    }
  },
  "signature": "..."
}
```

### 4.2 Command response (client → server)

```jsonc
{
  "v": "1.0",
  "id": "resp_...",
  "correlation_id": "<command id>",
  "type": "response",
  "ts": "...",
  "payload": {
    "status": "success" | "denied" | "error" | "timeout",
    "result": { ... } | null,
    "error": {                          // if status != success
      "code": "POLICY_DENIED" | "FILE_NOT_FOUND" | "TIMEOUT" | "INVALID_INPUT" | "RUNTIME_ERROR",
      "message": "...",
      "policy_rule": "deny:**/.env*" | null
    },
    "audit_entry_id": "audit_..."      // local audit log reference
  },
  "signature": "..."
}
```

### 4.3 Core tools (v1)

Each tool has a typed schema. Implementations MUST validate inputs before execution.

#### `read_file`
```jsonc
{
  "tool": "read_file",
  "arguments": {
    "path": "src/auth/middleware.ts",
    "max_bytes": 1048576,
    "focus_line": 42                   // optional; returns ±40 lines if provided
  }
}
// result: { "content": "...", "size": 12345, "hash": "sha256:..." }
```

#### `read_runtime_var`
```jsonc
{
  "tool": "read_runtime_var",
  "arguments": {
    "scope": "request" | "response" | "env" | "user" | "global",
    "var_path": "headers.host"
  }
}
// result: { "value": "..." }
```

#### `get_git_state`
```jsonc
{
  "tool": "get_git_state",
  "arguments": {}
}
// result: { "head_sha": "...", "branch": "...", "dirty": false, "remote_url": "..." }
```

#### `tail_log`
```jsonc
{
  "tool": "tail_log",
  "arguments": {
    "path": "/var/log/app.log",
    "lines": 200
  }
}
// result: { "lines": [...] }
```

#### `write_file` (Fase C only)
```jsonc
{
  "tool": "write_file",
  "arguments": {
    "path": "src/auth/middleware.ts",
    "content": "...",
    "expected_prior_hash": "sha256:..."  // fails if file changed; optimistic concurrency
  }
}
// result: { "prior_hash": "...", "new_hash": "...", "backup_path": "..." }
```

#### `apply_patch` (Fase C only)
```jsonc
{
  "tool": "apply_patch",
  "arguments": {
    "envelope": "*** Begin Patch ... *** End Patch",
    "dry_run": false
  }
}
// result: { "files_changed": [...], "backup_paths": [...] }
```

#### `run_command` (Fase C only)
```jsonc
{
  "tool": "run_command",
  "arguments": {
    "cmd": "npx tsc --noEmit",
    "cwd": "<project-root>",
    "env": { "NODE_ENV": "test" },     // policy may restrict
    "timeout_ms": 60000,
    "max_stdout_bytes": 65536
  }
}
// result: { "exit_code": 0, "stdout": "...", "stderr": "...", "duration_ms": 12345 }
```

#### `run_test` (Fase C only)
```jsonc
{
  "tool": "run_test",
  "arguments": {
    "pattern": "auth/**/*.test.ts",
    "timeout_ms": 120000
  }
}
// result: { "passed": true, "total": 42, "failed": 0, "duration_ms": ... }
```

#### `get_substrate_recording` (Fase D only)
```jsonc
{
  "tool": "get_substrate_recording",
  "arguments": {
    "fingerprint": "fp_..."
  }
}
// result: { "recording_id": "...", "events_count": 234, "size_bytes": ... }
```

#### `replay_recording` (Fase D only)
```jsonc
{
  "tool": "replay_recording",
  "arguments": {
    "recording_id": "...",
    "patch_envelope": "*** Begin Patch ...",  // optional; replay against patched code
    "timeout_ms": 30000
  }
}
// result: {
//   "original_reproduced_error": true,
//   "patched_reproduced_error": false,
//   "io_diff_summary": "...",
//   "attestation": "base64-ed25519",
//   "attested_hashes": { ... }
// }
```

### 4.4 Server tool-capability gating (subscription enforcement)

Commands server sends depend on `subscription_tier`:

| Tier | Allowed tools |
|---|---|
| `free` | (none — peer mode disabled entirely; observability only) |
| `pro` | `read_file`, `read_runtime_var`, `get_git_state`, `tail_log`, `write_file`, `apply_patch`, `run_command`, `run_test` |
| `enterprise` | All `pro` + `get_substrate_recording` + `replay_recording` + future Fase D tools |

If a client in `pro` tier receives `replay_recording`, it MUST return `{ status: "denied", error: { code: "TIER_INSUFFICIENT" } }` as a safety net — though the server shouldn't send this in the first place.

---

## 5. Events (bidirectional)

Events are observability messages that don't require response.

### 5.1 Client → server events

```jsonc
{
  "type": "event",
  "payload": {
    "kind": "error_captured" | "substrate_flush" | "policy_violation_detected" | "local_audit_entry",
    "data": { ... }
  }
}
```

### 5.2 Server → client events

```jsonc
{
  "type": "event",
  "payload": {
    "kind": "revoke_command" | "key_rotation_scheduled" | "policy_update_recommended",
    "data": { ... }
  }
}
```

### 5.3 Revoke command event

```jsonc
{
  "kind": "revoke_command",
  "data": {
    "target_command_id": "cmd_..." | "*",
    "reason": "session_compromised" | "user_abort" | "subscription_expired"
  }
}
```

Client MUST respond within 5s, aborting the target command if still in flight. If client doesn't respond, server force-disconnects; transport reopens on client side fresh.

---

## 6. Policy file format

Lives at `<project-root>/.inariwatch/policy.yml`. Loaded by SDK on `enableRemoteRemediation()`.

### 6.1 Schema

```yaml
version: 1
default: deny | allow   # mandatory. "deny" recommended.

# Permission level — three tiers
# - read-only: no writes, no exec
# - suggest:   writes go to .inariwatch/suggestions/, human must apply
# - auto-execute: full powers. Requires this exact string to unlock write tools.
level: read-only | suggest | auto-execute

permissions:
  read_file:
    allow:
      - "src/**/*.ts"
      - "package.json"
    deny:
      - "**/.env*"
      - "**/*secret*"
      - "**/node_modules/**"

  read_runtime_var:
    allow:
      - scope: request
        vars: ["headers.host", "url", "method"]
      - scope: user
        vars: ["id"]
    deny:
      - scope: env
        vars: ["*SECRET*", "*KEY*", "*TOKEN*", "DATABASE_URL"]

  write_file:
    allow:
      - "src/**/*.ts"
    deny:
      - "package.json"
      - "package-lock.json"
      - "**/.env*"
    require_confirm_above_bytes: 10000   # surface to user before applying

  run_command:
    allow:
      - "npx tsc --noEmit"
      - "npm test"
      - "npm run lint"
    deny:
      - "rm *"
      - "curl *"
      - "sudo *"
    regex_allowed:
      - "^npx\\s+\\w[\\w-]*\\s+--noEmit$"
    max_timeout_ms: 120000

audit:
  local_log: ".inariwatch/audit.log"
  retain_days: 30
  cloud_mirror: true
  format: jsonl

network:
  allowed_endpoints:
    - "peer.inariwatch.com:443"         # the only outbound the SDK itself makes
```

### 6.2 Policy evaluation

For a given tool + arguments:
1. If `level` insufficient for tool → deny
2. Check `permissions[tool].deny` patterns; if match → deny
3. Check `permissions[tool].allow` patterns; if match → allow
4. Else → fallback to `default`

All denials logged with full context to audit log.

### 6.3 Policy hash

SDK computes SHA-256 of canonicalized policy YAML. Included in handshake. Server may broadcast `policy_update_recommended` event if best-practice policy templates change.

---

## 7. Audit log

### 7.1 Format

JSONL file at path from `policy.yml → audit.local_log`. Append-only. One line per event.

```jsonc
{
  "id": "audit_01HGW...",
  "ts": "2026-04-22T15:30:00.000Z",
  "session_id": "sess_...",
  "correlation_id": "cmd_...",
  "tool": "read_file",
  "arguments_hash": "sha256:...",        // hash, not full args (policy may contain secrets)
  "policy_decision": "allow" | "deny",
  "policy_rule_matched": "allow:src/**/*.ts",
  "result_status": "success",
  "result_size": 4096,
  "duration_ms": 12,
  "server_signature": "..."              // signature on original command, archival
}
```

### 7.2 Retention

- Default 30 days
- Configurable via policy
- Archive to compressed .jsonl.gz monthly if `retain_days > 30`

### 7.3 Cloud mirror

If `audit.cloud_mirror: true`:
- Audit entries batched (1-min window or 100 entries)
- Uploaded to cloud via `POST /v1/audit/batch`
- Enables compliance reports + incident investigation
- Cloud-side retention per customer contract (Enterprise: 7 years; Pro: 90 days)

---

## 8. Error codes

| Code | When | Recovery |
|---|---|---|
| `POLICY_DENIED` | Tool call violates policy | Server should not retry; log and escalate |
| `TIER_INSUFFICIENT` | Tool not available in current subscription | Server should upgrade-prompt user |
| `TIMEOUT` | Tool execution exceeded budget | Server may retry with longer timeout (subject to policy max) |
| `FILE_NOT_FOUND` | Target doesn't exist | Server may try alternate path |
| `HASH_MISMATCH` | Optimistic concurrency failure on write | Server re-reads, retries with fresh hash |
| `INVALID_INPUT` | Argument schema violation | Server bug; should not retry |
| `RUNTIME_ERROR` | Unexpected exception in tool | Server may retry once; otherwise report to user |
| `SIGNATURE_INVALID` | Signature didn't verify | Client drops message; server may re-establish session |
| `VERSION_INCOMPATIBLE` | Protocol version mismatch | Client and server must negotiate common version |
| `SUBSCRIPTION_EXPIRED` | Token expired mid-session | Client should refresh token; server issues fresh commands after |

---

## 9. Versioning

### 9.1 Versioning scheme

- **Protocol version**: semver (v1.0, v1.1, v2.0)
- **Minor (v1.1)** adds non-breaking capabilities (new tools, new event kinds)
- **Major (v2.0)** breaks wire format; requires both sides to upgrade

### 9.2 Negotiation

On handshake, client sends `v`, server responds with closest compatible `v`. If no overlap → `VERSION_INCOMPATIBLE` error.

### 9.3 Current version

**v1.0** — covers Fases A–D of SDK plan. Fase E (multi-language) does NOT require protocol changes; it reuses v1.0.

Future versions reserved:
- **v1.1** — tentative: add `stream_command` for long-running commands with progress updates
- **v2.0** — tentative: post-quantum cryptography (once standardized by NIST)

---

## 10. Security properties (TLA+ informal)

**Property 1 — Authentication:** Every command from the server is verifiably signed by the cloud's current or recent signing key. Compromised keys revocable within 1 heartbeat cycle.

**Property 2 — Policy soundness:** No tool executes without policy decision `allow`. Policy `default: deny` is the safe default.

**Property 3 — No-silent-fail:** Every denied / errored tool call is recorded in local audit log. Cloud cannot suppress local audit.

**Property 4 — Subscription enforceability:** Cloud cannot issue tools beyond subscription tier. Client enforces as defense-in-depth via `enabled_capabilities` from handshake.

**Property 5 — User override:** `INARIWATCH_REMOTE_REMEDIATION=disabled` env var disables all peer mode regardless of any code-level config.

**Property 6 — Replay resistance:** Every command has unique `id`; client rejects repeats; `ts` window ±5min; replay attacks bounded by window.

**Property 7 — Forward secrecy:** Session keypair ephemeral; post-session key compromise doesn't retroactively expose past session content.

---

## 11. Conformance test suite

Implementations must pass the following tests (hosted at `orbita-pos/inariwatch-protocol-conformance`):

- **Handshake tests (10+):** good token, expired token, invalid token, version mismatch, tampered signature, absent signature, policy hash mismatch, etc.
- **Signature tests (15+):** Ed25519 correctness, JCS canonicalization, replay window, ID deduplication, clock skew handling
- **Command tests (one per tool):** happy path, policy deny, size/time limits, hash mismatch on writes, timeout handling
- **Revocation tests (5+):** command revoke in-flight, full-session revoke, force-disconnect on no-ack
- **Policy tests (20+):** allow/deny patterns, default behavior, level gating, glob edge cases, symlink handling
- **Audit tests (5+):** log format, retention, tamper-evidence (append-only check), cloud mirror batching

Any runtime implementation claiming v1.0 conformance must pass all these plus language-specific runtime behavior tests.

---

## 12. Open questions (v1.1 candidates)

- Streaming commands for long-running tasks (`run_command` with live stdout)
- Plugin architecture for custom tools (user-authored tools with policy declarations)
- Federation: multiple cloud providers sharing a peer (probably never; complexity not worth it)
- Inline attestation: include EAP attestation in every response, not just Fase D replay tools

---

End of protocol specification.
