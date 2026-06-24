/**
 * Tests for /api/eap/verify/tombstone/:hash — Track E pieza 11.
 *
 * Covers:
 *   - GET /attestor returns key info
 *   - POST happy path (sign in process A, verify in process B)
 *   - POST rejects content-hash mismatch (tampered fingerprint_hash)
 *   - POST rejects key-id mismatch (signed by a different key)
 *   - POST rejects URL-vs-body hash mismatch
 *   - POST returns 503 when attestor key is unavailable
 *
 * Crypto is real — we sign in the same process and verify the result.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, createHash, sign as cryptoSign } from "node:crypto";

vi.spyOn(console, "error").mockImplementation(() => undefined);

vi.mock("@/lib/webhooks/rate-limit", () => ({
  checkWebhookRateLimit: async () => ({ allowed: true }),
  extractClientIp: () => "127.0.0.1",
}));

function freshSecretHex(): { secretHex: string; pubkeyHex: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  const spki = publicKey.export({ format: "der", type: "spki" });
  return {
    secretHex: pkcs8.subarray(pkcs8.length - 32).toString("hex"),
    pubkeyHex: spki.subarray(spki.length - 32).toString("hex"),
  };
}

async function loadRoute() {
  return (await import("../route")) as typeof import("../route");
}

function mkPostReq(hash: string, body: unknown): import("next/server").NextRequest {
  return new Request(`https://app.inariwatch.com/api/eap/verify/tombstone/${hash}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

function mkGetReq(hash: string): import("next/server").NextRequest {
  return new Request(
    `https://app.inariwatch.com/api/eap/verify/tombstone/${hash}`,
  ) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.resetModules();
  delete process.env.INARIWATCH_TOMBSTONE_KEY_HEX;
});

afterEach(() => {
  delete process.env.INARIWATCH_TOMBSTONE_KEY_HEX;
});

describe("GET /attestor", () => {
  it("returns key_available=false when env unset", async () => {
    const { GET } = await loadRoute();
    const res = await GET(mkGetReq("attestor"), {
      params: Promise.resolve({ hash: "attestor" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.keyAvailable).toBe(false);
    expect(json.algorithm).toBe("ed25519");
  });

  it("returns key_available=true with pubkey when env set", async () => {
    process.env.INARIWATCH_TOMBSTONE_KEY_HEX = freshSecretHex().secretHex;
    const { GET } = await loadRoute();
    const res = await GET(mkGetReq("attestor"), {
      params: Promise.resolve({ hash: "attestor" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.keyAvailable).toBe(true);
    expect(json.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(json.keyId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("POST verify", () => {
  it("verifies a freshly signed tombstone", async () => {
    process.env.INARIWATCH_TOMBSTONE_KEY_HEX = freshSecretHex().secretHex;
    const { POST } = await loadRoute();
    const { signTombstone } = await import("@/lib/services/tombstone-sign");

    const r = signTombstone({
      fingerprint: "fp-test",
      integrationId: "11111111-2222-3333-4444-555555555555",
      processedActions: ["analyzed", "notified"],
    });
    if (!r.ok) throw new Error("sign failed");
    const t = r.tombstone;

    const res = await POST(mkPostReq(t.tombstone_id, t), {
      params: Promise.resolve({ hash: t.tombstone_id }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.verified).toBe(true);
    expect(json.tombstone_id).toBe(t.tombstone_id);
    expect(json.attestor).toBe("inariwatch");
  });

  it("rejects content tampering (mutated processed_actions)", async () => {
    process.env.INARIWATCH_TOMBSTONE_KEY_HEX = freshSecretHex().secretHex;
    const { POST } = await loadRoute();
    const { signTombstone } = await import("@/lib/services/tombstone-sign");

    const r = signTombstone({
      fingerprint: "fp",
      integrationId: "11111111-2222-3333-4444-555555555555",
      processedActions: ["analyzed"],
    });
    if (!r.ok) throw new Error("sign failed");
    const t = r.tombstone;

    // Mutate processed_actions but keep tombstone_id (= URL hash) stable.
    // Server recomputes canonical hash → mismatch → reject.
    const tampered = { ...t, processed_actions: ["analyzed", "notified"] };
    const res = await POST(mkPostReq(t.tombstone_id, tampered), {
      params: Promise.resolve({ hash: t.tombstone_id }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.verified).toBe(false);
    expect(json.reason).toBe("content-hash-mismatch");
  });

  it("rejects URL hash != body tombstone_id", async () => {
    process.env.INARIWATCH_TOMBSTONE_KEY_HEX = freshSecretHex().secretHex;
    const { POST } = await loadRoute();
    const { signTombstone } = await import("@/lib/services/tombstone-sign");

    const r = signTombstone({
      fingerprint: "fp",
      integrationId: "11111111-2222-3333-4444-555555555555",
      processedActions: ["analyzed"],
    });
    if (!r.ok) throw new Error("sign failed");
    const wrongHash = "0".repeat(64);

    const res = await POST(mkPostReq(wrongHash, r.tombstone), {
      params: Promise.resolve({ hash: wrongHash }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.verified).toBe(false);
    expect(json.reason).toBe("hash-url-mismatch");
  });

  it("rejects tombstone signed by a different key (key_id mismatch)", async () => {
    // Sign with key A, then deploy server with key B and attempt to verify.
    const keyA = freshSecretHex();
    process.env.INARIWATCH_TOMBSTONE_KEY_HEX = keyA.secretHex;
    const { signTombstone } = await import("@/lib/services/tombstone-sign");
    const r = signTombstone({
      fingerprint: "fp",
      integrationId: "11111111-2222-3333-4444-555555555555",
      processedActions: ["analyzed"],
    });
    if (!r.ok) throw new Error("sign failed");

    // Rotate the env to a different key, reload modules so the cache
    // re-reads the new value.
    vi.resetModules();
    process.env.INARIWATCH_TOMBSTONE_KEY_HEX = freshSecretHex().secretHex;
    const { POST } = await loadRoute();

    const res = await POST(mkPostReq(r.tombstone.tombstone_id, r.tombstone), {
      params: Promise.resolve({ hash: r.tombstone.tombstone_id }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.verified).toBe(false);
    expect(json.reason).toBe("key-id-mismatch");
  });

  it("returns 503 attestor-unavailable when env is unset", async () => {
    const { POST } = await loadRoute();
    // Build a syntactically valid body so we get past structural validation.
    const id = "a".repeat(64);
    const body = {
      v: 1,
      ts: "2026-04-25T00:00:00.000Z",
      fingerprint_hash: "f".repeat(64),
      processed_actions: ["analyzed"],
      integration_id: "11111111-2222-3333-4444-555555555555",
      key_id: "0123456789abcdef",
      tombstone_id: id,
      sig: "ed25519:" + "0".repeat(128),
      pubkey: "0".repeat(64),
    };
    const res = await POST(mkPostReq(id, body), {
      params: Promise.resolve({ hash: id }),
    });
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.reason).toBe("attestor-unavailable");
  });

  it("rejects malformed sig prefix", async () => {
    process.env.INARIWATCH_TOMBSTONE_KEY_HEX = freshSecretHex().secretHex;
    const { POST } = await loadRoute();
    const { signTombstone } = await import("@/lib/services/tombstone-sign");
    const r = signTombstone({
      fingerprint: "fp",
      integrationId: "11111111-2222-3333-4444-555555555555",
      processedActions: ["analyzed"],
    });
    if (!r.ok) throw new Error("sign failed");

    const bad = { ...r.tombstone, sig: "rsa:" + "0".repeat(128) };
    const res = await POST(mkPostReq(r.tombstone.tombstone_id, bad), {
      params: Promise.resolve({ hash: r.tombstone.tombstone_id }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe("malformed");
  });
});

// quiet unused imports warning
void createHash;
void cryptoSign;
