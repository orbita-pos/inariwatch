// v0.3 S5 — JSON-RPC 2.0 wire shapes shared between the sidecar's
// main loop and its handler modules. Mirrors the Rust types in
// `desktop/src-tauri/src/whatsapp/types.rs` — changing one side requires
// changing the other (both sides round-trip through JSON).

export type ConnectionStatus =
  | "disconnected"
  | "qr_pending"
  | "connected"
  | "reconnecting"
  | "failed";

// ── RPC method registry ────────────────────────────────────────────────────

export interface LoginStartParams {
  account_id: string;
  label: string;
}

export interface SendMessageParams {
  account_id: string;
  /** E.164 phone, no leading `+`, no spaces. */
  to: string;
  body: string;
  /** Optional WAMessage id to reply to. */
  reply_to?: string;
}

export interface SendMessageResult {
  message_id: string;
  to_jid: string;
}

export interface LogoutParams {
  account_id: string;
}

export interface StatusParams {
  account_id: string;
}

export interface AccountInfo {
  account_id: string;
  label: string;
  self_jid: string | null;
  status: ConnectionStatus;
  last_qr_at_ms: number | null;
  last_linked_at_ms: number | null;
}

// ── Event payloads ─────────────────────────────────────────────────────────
//
// Wire shape: a JSON-RPC notification with method "event" + params being
// one of the discriminated WhatsAppEvent variants below.

export type WhatsAppEvent =
  | { type: "qr_update"; account_id: string; qr: string; ts_ms: number }
  | {
      type: "linked";
      account_id: string;
      self_jid: string;
      ts_ms: number;
    }
  | { type: "logged_out"; account_id: string; ts_ms: number }
  | {
      type: "connection_state_changed";
      account_id: string;
      status: ConnectionStatus;
      ts_ms: number;
    }
  | {
      type: "fatal";
      account_id: string | null;
      message: string;
      ts_ms: number;
    };

// ── JSON-RPC frame shapes ──────────────────────────────────────────────────

export interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

// JSON-RPC standard error codes (subset).
export const RPC_ERR_PARSE = -32700;
export const RPC_ERR_INVALID_REQUEST = -32600;
export const RPC_ERR_METHOD_NOT_FOUND = -32601;
export const RPC_ERR_INVALID_PARAMS = -32602;
export const RPC_ERR_INTERNAL = -32603;
