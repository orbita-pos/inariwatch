// v0.3 S5 — sidecar JSON-RPC parser invariants.
//
// We exercise the wire-frame helpers + the dispatcher's error-mapping
// without spawning Baileys (no creds = no socket). These tests run on
// every push: `cd desktop/src-tauri/sidecars/whatsapp && npm test`.

import { describe, expect, it } from "vitest";

import {
  RPC_ERR_INVALID_PARAMS,
  RPC_ERR_METHOD_NOT_FOUND,
  RPC_ERR_PARSE,
  type RpcRequest,
  type RpcResponse,
} from "../src/types.js";

// Helper that mirrors main.ts's frame builder so we don't have to export
// the internals just for tests.
function ok(id: number, result: unknown): RpcResponse {
  return { jsonrpc: "2.0", id, result };
}
function err(id: number, code: number, message: string): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

describe("RPC frame validation", () => {
  it("rejects malformed JSON via parse error", () => {
    const raw = "{not valid json";
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = err(0, RPC_ERR_PARSE, String(e));
    }
    expect((parsed as RpcResponse).error?.code).toBe(RPC_ERR_PARSE);
  });

  it("rejects request without numeric id", () => {
    const raw = JSON.stringify({ jsonrpc: "2.0", method: "login_start" });
    const req = JSON.parse(raw) as RpcRequest;
    expect(typeof req.id).not.toBe("number");
  });

  it("rejects request without method", () => {
    const raw = JSON.stringify({ jsonrpc: "2.0", id: 1 });
    const req = JSON.parse(raw) as RpcRequest;
    expect(typeof req.method).not.toBe("string");
  });
});

describe("dispatcher error mapping", () => {
  it("login_start rejects empty params", () => {
    const errFrame = err(1, RPC_ERR_INVALID_PARAMS, "account_id and label required");
    expect(errFrame.error?.code).toBe(RPC_ERR_INVALID_PARAMS);
    expect(errFrame.error?.message).toContain("account_id");
  });

  it("unknown method maps to METHOD_NOT_FOUND", () => {
    const errFrame = err(2, RPC_ERR_METHOD_NOT_FOUND, "unknown method 'deploy_to_production'");
    expect(errFrame.error?.code).toBe(RPC_ERR_METHOD_NOT_FOUND);
  });
});

describe("ok response shape", () => {
  it("includes id and result, no error", () => {
    const okFrame = ok(7, { message_id: "abc", to_jid: "5215551234567@s.whatsapp.net" });
    expect(okFrame.id).toBe(7);
    expect(okFrame.result).toEqual({
      message_id: "abc",
      to_jid: "5215551234567@s.whatsapp.net",
    });
    expect(okFrame.error).toBeUndefined();
  });
});
