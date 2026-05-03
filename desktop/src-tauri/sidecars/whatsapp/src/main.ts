// v0.3 S5 — Baileys WhatsApp sidecar entry point.
//
// JSON-RPC 2.0 server over stdin/stdout. Each line is one frame.
// Inari Live's `crate::whatsapp::SidecarManager` is the single
// authorized client; the sidecar is not exposed on a network port.
//
// ## RPC methods
//
//   login_start({ account_id, label })           → {}
//   send_message({ account_id, to, body, reply_to? }) → { message_id, to_jid }
//   logout({ account_id })                       → {}
//   status({ account_id })                       → AccountInfo | null
//
// ## Notifications (sidecar → manager)
//
//   { method: "event", params: { type: "qr_update" | "linked" | ... } }
//
// ## Rate limiting (TOS gray area mitigation)
//
// 80 messages/sec/account ceiling — Meta tolerates short bursts up to
// roughly that rate before flagging the session. Anything heavier
// (incident-storm scenarios) gets queued by the relay caller, not by us.

import process from "node:process";
import readline from "node:readline";
import { join } from "node:path";

import { Session } from "./session.js";
import {
  RPC_ERR_INTERNAL,
  RPC_ERR_INVALID_PARAMS,
  RPC_ERR_METHOD_NOT_FOUND,
  RPC_ERR_PARSE,
  type AccountInfo,
  type LoginStartParams,
  type LogoutParams,
  type RpcRequest,
  type RpcResponse,
  type SendMessageParams,
  type SendMessageResult,
  type StatusParams,
  type WhatsAppEvent,
} from "./types.js";

// ── Per-process state ──────────────────────────────────────────────────────

interface AccountSlot {
  info: AccountInfo;
  session: Session;
  /** Tokens earned per second for outbound rate limiting. */
  bucket: { tokens: number; lastRefillMs: number };
}

const sessions = new Map<string, AccountSlot>();

// ── CLI args (auth root) ──────────────────────────────────────────────────

function parseArgs(): { authRoot: string } {
  const args = process.argv.slice(2);
  let authRoot = "";
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--auth-root" && i + 1 < args.length) {
      authRoot = args[i + 1];
      i += 1;
    }
  }
  if (!authRoot) {
    process.stderr.write(
      "[whatsapp-sidecar] --auth-root <path> is required\n",
    );
    process.exit(2);
  }
  return { authRoot };
}

// ── Wire helpers ───────────────────────────────────────────────────────────

function send(frame: RpcResponse | { jsonrpc: "2.0"; method: string; params: unknown }): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function emit(event: WhatsAppEvent): void {
  send({ jsonrpc: "2.0", method: "event", params: event });
}

function ok(id: number, result: unknown): RpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function err(id: number, code: number, message: string): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// ── Method handlers ────────────────────────────────────────────────────────

async function handleLoginStart(
  authRoot: string,
  params: LoginStartParams,
): Promise<void> {
  const existing = sessions.get(params.account_id);
  if (existing) {
    // Restart the session — useful when "Reconnect" is clicked.
    await existing.session.logout().catch(() => undefined);
    sessions.delete(params.account_id);
  }
  const accountDir = join(authRoot, params.account_id);
  const session = new Session({
    accountId: params.account_id,
    label: params.label,
    accountDir,
    emit,
  });
  sessions.set(params.account_id, {
    info: {
      account_id: params.account_id,
      label: params.label,
      self_jid: null,
      status: "qr_pending",
      last_qr_at_ms: null,
      last_linked_at_ms: null,
    },
    session,
    bucket: { tokens: 80, lastRefillMs: Date.now() },
  });
  // Fire and forget — events flow through `emit`.
  void session.start().catch((sessionErr) => {
    process.stderr.write(
      `[whatsapp-sidecar] session ${params.account_id} ended: ${String(sessionErr)}\n`,
    );
  });
}

async function handleSendMessage(
  params: SendMessageParams,
): Promise<SendMessageResult> {
  const slot = sessions.get(params.account_id);
  if (!slot) {
    throw new Error(`account '${params.account_id}' is not linked`);
  }
  // Token-bucket refill (80 tokens/sec). Gives natural backpressure
  // without an external dep — overflow callers see "rate-limited".
  const now = Date.now();
  const elapsedMs = now - slot.bucket.lastRefillMs;
  if (elapsedMs > 0) {
    const refill = (elapsedMs / 1000) * 80;
    slot.bucket.tokens = Math.min(80, slot.bucket.tokens + refill);
    slot.bucket.lastRefillMs = now;
  }
  if (slot.bucket.tokens < 1) {
    throw new Error(
      "rate-limited (>80 msg/sec/account — TOS-safety throttle)",
    );
  }
  slot.bucket.tokens -= 1;
  const result = await slot.session.send(params.to, params.body, params.reply_to);
  return { message_id: result.messageId, to_jid: result.toJid };
}

async function handleLogout(params: LogoutParams): Promise<void> {
  const slot = sessions.get(params.account_id);
  if (!slot) return;
  await slot.session.logout();
  sessions.delete(params.account_id);
}

function handleStatus(params: StatusParams): AccountInfo | null {
  const slot = sessions.get(params.account_id);
  if (!slot) return null;
  return {
    ...slot.info,
    status: slot.session.getStatus(),
    self_jid: slot.session.getSelfJid(),
  };
}

// ── Dispatcher ─────────────────────────────────────────────────────────────

async function dispatch(
  authRoot: string,
  req: RpcRequest,
): Promise<RpcResponse> {
  try {
    switch (req.method) {
      case "login_start": {
        const params = req.params as LoginStartParams;
        if (!params?.account_id || !params?.label) {
          return err(req.id, RPC_ERR_INVALID_PARAMS, "account_id and label required");
        }
        await handleLoginStart(authRoot, params);
        return ok(req.id, {});
      }
      case "send_message": {
        const params = req.params as SendMessageParams;
        if (!params?.account_id || !params?.to || !params?.body) {
          return err(req.id, RPC_ERR_INVALID_PARAMS, "account_id, to, body required");
        }
        const result = await handleSendMessage(params);
        return ok(req.id, result);
      }
      case "logout": {
        const params = req.params as LogoutParams;
        if (!params?.account_id) {
          return err(req.id, RPC_ERR_INVALID_PARAMS, "account_id required");
        }
        await handleLogout(params);
        return ok(req.id, {});
      }
      case "status": {
        const params = req.params as StatusParams;
        if (!params?.account_id) {
          return err(req.id, RPC_ERR_INVALID_PARAMS, "account_id required");
        }
        return ok(req.id, handleStatus(params));
      }
      default:
        return err(req.id, RPC_ERR_METHOD_NOT_FOUND, `unknown method '${req.method}'`);
    }
  } catch (e) {
    return err(req.id, RPC_ERR_INTERNAL, e instanceof Error ? e.message : String(e));
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { authRoot } = parseArgs();
  process.stderr.write(
    `[whatsapp-sidecar] starting; auth-root=${authRoot}\n`,
  );

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: RpcRequest;
    try {
      req = JSON.parse(trimmed) as RpcRequest;
    } catch (parseErr) {
      send(err(0, RPC_ERR_PARSE, `parse: ${String(parseErr)}`));
      return;
    }
    if (req.jsonrpc !== "2.0" || typeof req.id !== "number" || typeof req.method !== "string") {
      send(err(typeof req.id === "number" ? req.id : 0, RPC_ERR_PARSE, "invalid frame"));
      return;
    }
    void dispatch(authRoot, req).then(send);
  });

  rl.on("close", async () => {
    // stdin closed → manager dropped us. Logout each session cleanly.
    for (const [, slot] of sessions) {
      await slot.session.logout().catch(() => undefined);
    }
    process.exit(0);
  });

  process.on("uncaughtException", (e) => {
    emit({
      type: "fatal",
      account_id: null,
      message: e instanceof Error ? e.message : String(e),
      ts_ms: Date.now(),
    });
  });
}

main().catch((e) => {
  process.stderr.write(
    `[whatsapp-sidecar] fatal: ${e instanceof Error ? e.stack : String(e)}\n`,
  );
  process.exit(1);
});
