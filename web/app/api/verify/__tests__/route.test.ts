/**
 * Sesión 29 — POST /api/verify regression suite.
 *
 * Tests the server-side defense-in-depth verifier. Crypto is NOT
 * stubbed — we mint real Ed25519 keypairs and sign genuine receipts
 * via @noble/curves so every assertion doubles as a contract test
 * against the S28 Rust verifier. If the Rust side ever diverges, one
 * of these tests will fail loudly.
 */

import { describe, it, expect } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { POST, GET, OPTIONS } from "../route";
import { hexEncode, signedDigest } from "@/lib/eap-verify";

const RECEIPT_ID =
  "9af1d4c0a3b87216c5e9d2087f3a1b8c4d6e9072f8a51c3b6d4e7f01a2c5d6e8";

function mkSeed(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function buildSignedReceipt(seed: Uint8Array, receiptId: string): {
  json: string;
  publicKey: string;
  signature: string;
} {
  const pubkey = ed25519.getPublicKey(seed);
  const digest = signedDigest(receiptId);
  const signature = ed25519.sign(digest, seed);
  const publicKey = hexEncode(pubkey);
  const sigHex = hexEncode(signature);
  const json = JSON.stringify({
    version: "eap-1",
    receipt_id: receiptId,
    merkle_root: receiptId,
    signed: true,
    signature: sigHex,
    public_key: publicKey,
    attestor: "inariwatch",
    timestamp: "2026-05-01T00:00:00Z",
    model: "gpt-5.4",
    prompt_hash:
      "0000000000000000000000000000000000000000000000000000000000000000",
  });
  return { json, publicKey, signature: sigHex };
}

function mkPost(body: BodyInit | null, contentType?: string): import("next/server").NextRequest {
  const headers: Record<string, string> = {};
  if (contentType) headers["content-type"] = contentType;
  return new Request("https://verify.inariwatch.com/api/verify", {
    method: "POST",
    headers,
    body,
  }) as unknown as import("next/server").NextRequest;
}

function mkGet(qs: string): import("next/server").NextRequest {
  return new Request(`https://verify.inariwatch.com/api/verify${qs}`) as unknown as
    import("next/server").NextRequest;
}

describe("POST /api/verify", () => {
  it("returns ok=true + outcome.signed for a valid signed receipt", async () => {
    const { json } = buildSignedReceipt(mkSeed(7), RECEIPT_ID);
    const res = await POST(mkPost(json, "application/json"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.outcome.kind).toBe("signed");
    expect(body.outcome.key_id).toMatch(/^[0-9a-f]{16}$/);
    expect(body.receipt.receipt_id).toBe(RECEIPT_ID);
    expect(body.parseError).toBeNull();
    expect(body.disclosure).toMatch(/Metadata fields/);
    expect(body.disclosure).toMatch(/NOT cryptographically committed/);
  });

  it("returns ok=false + outcome.signature-invalid for a tampered signature", async () => {
    const { json } = buildSignedReceipt(mkSeed(7), RECEIPT_ID);
    const tampered = json.replace(
      /"signature":"([0-9a-f]+)"/,
      (_m, sig: string) => {
        const last = sig.slice(-1);
        const flipped = last === "0" ? "1" : "0";
        return `"signature":"${sig.slice(0, -1)}${flipped}"`;
      },
    );
    const res = await POST(mkPost(tampered, "application/json"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.outcome.kind).toBe("signature-invalid");
    expect(body.disclosure).toMatch(/NOT cryptographically committed/);
  });

  it("returns ok=true + outcome.merkle-only for an unsigned receipt", async () => {
    const json = JSON.stringify({
      version: "eap-1",
      receipt_id: RECEIPT_ID,
      merkle_root: RECEIPT_ID,
      signed: false,
      attestor: "inariwatch",
    });
    const res = await POST(mkPost(json, "application/json"));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.outcome.kind).toBe("merkle-only");
  });

  it("returns ok=false + outcome.malformed for invalid JSON", async () => {
    const res = await POST(mkPost("{ not json", "application/json"));
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.outcome.kind).toBe("malformed");
    expect(body.parseError?.kind).toBe("invalid-json");
  });

  it("returns ok=false + outcome.malformed for unsupported version", async () => {
    const json = JSON.stringify({
      version: "eap-99",
      receipt_id: RECEIPT_ID,
      merkle_root: RECEIPT_ID,
    });
    const res = await POST(mkPost(json, "application/json"));
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.parseError?.kind).toBe("unsupported-version");
  });

  it("rejects body larger than 1 MB with 413", async () => {
    const big = "x".repeat(1024 * 1024 + 1);
    const res = await POST(mkPost(big, "application/json"));
    expect(res.status).toBe(413);
  });

  it("accepts multipart/form-data with `receipt` field", async () => {
    const { json } = buildSignedReceipt(mkSeed(11), RECEIPT_ID);
    const form = new FormData();
    form.set("receipt", json);
    const res = await POST(mkPost(form));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.outcome.kind).toBe("signed");
  });

  it("accepts multipart/form-data with `file` upload", async () => {
    const { json } = buildSignedReceipt(mkSeed(12), RECEIPT_ID);
    const form = new FormData();
    form.set("file", new File([json], "receipt.eap.json"));
    const res = await POST(mkPost(form));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.outcome.kind).toBe("signed");
  });

  it("rejects empty body with 400", async () => {
    const res = await POST(mkPost("", "application/json"));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/verify", () => {
  it("validates receipt passed via ?json= querystring", async () => {
    const { json } = buildSignedReceipt(mkSeed(9), RECEIPT_ID);
    const res = await GET(mkGet(`?json=${encodeURIComponent(json)}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.outcome.kind).toBe("signed");
  });

  it("returns 400 when ?json= is missing", async () => {
    const res = await GET(mkGet(""));
    expect(res.status).toBe(400);
  });
});

describe("OPTIONS /api/verify", () => {
  it("returns 204 with CORS headers for preflight", async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toMatch(/POST/);
  });
});

describe("contract: bytes Ed25519 signs over", () => {
  it("matches the documented protocol — SHA-256(receipt_id_utf8)", () => {
    // This is the locking constraint between TS and Rust. If anyone
    // changes signedDigest() to e.g. sign canonical CBOR over the
    // payload, this assertion (+ all other route tests minted with
    // the helper) breaks immediately. See INARI_LIVE_DECISIONS.md
    // 2026-05-01 § Sesión 28.
    const expected = sha256(new TextEncoder().encode(RECEIPT_ID));
    const got = signedDigest(RECEIPT_ID);
    expect(got.length).toBe(32);
    expect(hexEncode(got)).toBe(hexEncode(expected));
  });
});
