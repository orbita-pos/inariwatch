# Baileys WhatsApp sidecar (`@inariwatch/whatsapp-sidecar`, v0.3 S5)

Node child process spawned by Inari Live (`crate::whatsapp::SidecarManager`)
that maintains QR-paired WhatsApp sessions via
[`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys) and
serves outbound `send_message` calls over JSON-RPC 2.0 (stdin/stdout).

## Why this exists

InariWatch v0.3 S5 sends WhatsApp alerts FROM the user's own personal
WhatsApp account (paired via QR) — not from a Meta WhatsApp Business
Cloud API number, not from a Twilio sandbox. The prior S5 attempt used
WABA + Twilio fallback (see `30c935d` on
`feat/inari-live-v0.3-session5-whatsapp-voice`) and was rejected
2026-05-02 in favor of this Baileys-local-only model:

| | WABA + Twilio (rejected) | Baileys (this) |
|---|---|---|
| Setup | Meta business verification 1-3 weeks | Scan QR once |
| Per-message cost | ~$0.005-0.05 | $0 |
| Sender number | Vendor-rented | User's own |
| Message types | Templates only (pre-approved) | Free text |
| Receiver UX | "From an unknown business" | "From a friend" |

## Architecture

```
desktop/src-tauri/src/whatsapp/sidecar.rs (Rust)
     │ stdin/stdout, line-delimited JSON-RPC 2.0
     ▼
desktop/src-tauri/sidecars/whatsapp/dist/main.js (this package)
     │ Baileys WS protocol
     ▼
WhatsApp servers
```

One process, N accounts. Each account has its own `Session` (in
`src/session.ts`) with its own Baileys socket but shares the JSON-RPC
channel back to Rust.

## Build

```bash
cd desktop/src-tauri/sidecars/whatsapp
npm install
npm run build   # tsc → dist/main.js
```

Inari Live boots the sidecar with:
```
node desktop/src-tauri/sidecars/whatsapp/dist/main.js \
  --auth-root <app_local_data_dir>/inari-live/whatsapp
```

## RPC API

```typescript
// Rust → Node
interface RpcRequest { jsonrpc: "2.0"; id: number; method: string; params: unknown }

// Methods:
"login_start"  ({ account_id, label })                  → {}
"send_message" ({ account_id, to, body, reply_to? })    → { message_id, to_jid }
"logout"       ({ account_id })                         → {}
"status"       ({ account_id })                         → AccountInfo | null

// Node → Rust (no `id` = notification)
"event" with params: { type: "qr_update"   | "linked" | "logged_out"
                          | "connection_state_changed" | "fatal", ... }
```

See `src/types.ts` for full payload shapes.

## TOS gray area + ban risk (READ THIS BEFORE SHIPPING)

WhatsApp's Terms of Service prohibit "automated or unauthorized" use.
Baileys reverse-engineers the official mobile-app WebSocket protocol
and is technically in violation. Real-world impact (per Baileys'
README + community reports):

- **Low-volume personal use:** ~no risk of ban (millions of users
  including the official Baileys community).
- **Bot-shaped traffic** (high-volume, spammy content, link-farming):
  Meta has banned numbers for this. Bans are usually permanent for the
  number, NOT the account holder.
- **Commercial use** (sending to non-contacts, marketing): definitively
  bannable.

Mitigations baked into this sidecar:

1. **80 msg/sec/account rate limit** (token bucket in `main.ts`).
   Anything higher returns `rate-limited` to the caller.
2. **No marketing-style payloads** by default — alerts are
   incident-driven, sent to recipients the user already messages.
3. **Plain text bodies only** in v0.3 — no Buttons/List interactive
   messages (those are only "safe" inside Cloud API templates).

If the user's account gets banned, they re-pair with a different
number. We do NOT auto-recover bans.

## Voice notifications: separate

Voice TTS (`voice.tts.alert`, `voice.tts.digest`) runs through Piper
in `desktop/src-tauri/src/voice/`, NOT through this sidecar. WhatsApp
voice messages would need an audio-message Baileys API call we're not
exposing in v0.3.

## Tests

```bash
npm test
```

Vitest covers JSON-RPC parser, auth-store backup pattern, and
backoff progression. Integration tests against a real Baileys
session live in `desktop/src-tauri/tests/whatsapp_sidecar_smoke.rs`
(opt-in via `whatsapp-smoke` feature).
