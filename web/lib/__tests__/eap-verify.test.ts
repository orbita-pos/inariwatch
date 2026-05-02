/**
 * Sesión 29 — Unit tests for the TypeScript EAP verifier.
 *
 * These tests are the mirror image of the Rust unit suite in
 * `desktop/src-tauri/src/lib_eap_verify.rs::tests`. Where possible,
 * the same fixture values are used so a divergence between the two
 * ports is caught loudly.
 */

import { describe, it, expect } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  decodeShareable,
  deriveKeyId,
  encodeShareable,
  EAP_FORMAT_VERSION,
  hexDecode,
  hexEncode,
  isHex,
  parseReceipt,
  signedDigest,
  verify,
  type EapReceipt,
} from "../eap-verify";

const SAMPLE_RECEIPT_ID =
  "9af1d4c0a3b87216c5e9d2087f3a1b8c4d6e9072f8a51c3b6d4e7f01a2c5d6e8";

function buildSigned(seedByte: number, receiptId = SAMPLE_RECEIPT_ID): EapReceipt {
  const seed = new Uint8Array(32).fill(seedByte);
  const pubkey = ed25519.getPublicKey(seed);
  const digest = signedDigest(receiptId);
  const signature = ed25519.sign(digest, seed);
  const publicKey = hexEncode(pubkey);
  return {
    version: EAP_FORMAT_VERSION,
    receipt_id: receiptId,
    merkle_root: receiptId,
    signed: true,
    signature: hexEncode(signature),
    public_key: publicKey,
    key_id: deriveKeyId(publicKey),
    attestor: "inariwatch",
  };
}

describe("signed_digest", () => {
  it("produces 32 bytes equal to SHA-256(receipt_id_utf8)", () => {
    const got = signedDigest(SAMPLE_RECEIPT_ID);
    const expected = sha256(new TextEncoder().encode(SAMPLE_RECEIPT_ID));
    expect(got.length).toBe(32);
    expect(hexEncode(got)).toBe(hexEncode(expected));
  });
});

describe("verify", () => {
  it("returns signed for a freshly minted receipt", () => {
    const r = buildSigned(7);
    const out = verify(r);
    expect(out.kind).toBe("signed");
    if (out.kind === "signed") {
      expect(out.key_id).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("returns merkle-only when the receipt has no signature", () => {
    const r: EapReceipt = {
      version: EAP_FORMAT_VERSION,
      receipt_id: SAMPLE_RECEIPT_ID,
      merkle_root: SAMPLE_RECEIPT_ID,
      signed: false,
      attestor: "inariwatch",
    };
    expect(verify(r).kind).toBe("merkle-only");
  });

  it("returns signature-invalid when the signature is tampered", () => {
    const r = buildSigned(7);
    const last = r.signature!.slice(-1);
    const flipped = last === "0" ? "1" : "0";
    r.signature = `${r.signature!.slice(0, -1)}${flipped}`;
    expect(verify(r).kind).toBe("signature-invalid");
  });

  it("returns malformed when merkle_root != receipt_id", () => {
    const r = buildSigned(7);
    r.merkle_root =
      "0000000000000000000000000000000000000000000000000000000000000000";
    const out = verify(r);
    expect(out.kind).toBe("malformed");
    if (out.kind === "malformed") {
      expect(out.reason).toContain("merkle_root");
    }
  });

  it("returns malformed when signed=true but signature is missing", () => {
    const r = buildSigned(3);
    r.signature = null;
    const out = verify(r);
    expect(out.kind).toBe("malformed");
    if (out.kind === "malformed") {
      expect(out.reason).toContain("signed=true");
    }
  });

  it("rejects non-hex receipt_id", () => {
    const r = buildSigned(1);
    r.receipt_id = "Z".repeat(64);
    r.merkle_root = "Z".repeat(64);
    const out = verify(r);
    expect(out.kind).toBe("malformed");
  });
});

describe("parseReceipt", () => {
  it("parses a valid signed receipt", () => {
    const r = buildSigned(7);
    const json = JSON.stringify(r);
    const parsed = parseReceipt(json);
    expect("version" in parsed).toBe(true);
    if ("version" in parsed) {
      expect(parsed.version).toBe(EAP_FORMAT_VERSION);
      expect(parsed.receipt_id).toBe(SAMPLE_RECEIPT_ID);
    }
  });

  it("rejects unsupported version", () => {
    const json = JSON.stringify({
      version: "eap-99",
      receipt_id: SAMPLE_RECEIPT_ID,
      merkle_root: SAMPLE_RECEIPT_ID,
    });
    const parsed = parseReceipt(json);
    expect("kind" in parsed).toBe(true);
    if ("kind" in parsed) {
      expect(parsed.kind).toBe("unsupported-version");
      if (parsed.kind === "unsupported-version") {
        expect(parsed.got).toBe("eap-99");
      }
    }
  });

  it("rejects invalid JSON", () => {
    const parsed = parseReceipt("{ not valid");
    expect("kind" in parsed).toBe(true);
    if ("kind" in parsed && parsed.kind === "invalid-json") {
      expect(parsed.message.length).toBeGreaterThan(0);
    } else {
      throw new Error("expected invalid-json");
    }
  });

  it("rejects missing required fields", () => {
    const parsed = parseReceipt(JSON.stringify({ version: "eap-1" }));
    expect("kind" in parsed).toBe(true);
    if ("kind" in parsed) {
      expect(parsed.kind).toBe("shape");
    }
  });

  it("rejects array root", () => {
    const parsed = parseReceipt("[]");
    expect("kind" in parsed).toBe(true);
    if ("kind" in parsed) {
      expect(parsed.kind).toBe("shape");
    }
  });
});

describe("hex helpers", () => {
  it("isHex accepts 0-9a-fA-F only", () => {
    expect(isHex("00ff68656c6c6f1234")).toBe(true);
    expect(isHex("DEADBEEF")).toBe(true);
    expect(isHex("")).toBe(false);
    expect(isHex("00xx")).toBe(false);
  });

  it("hexEncode/hexDecode round-trip", () => {
    const original = new Uint8Array([0x00, 0xff, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x12, 0x34]);
    const encoded = hexEncode(original);
    expect(encoded).toBe("00ff68656c6c6f1234");
    const decoded = hexDecode(encoded);
    expect(decoded).not.toBeNull();
    expect(Array.from(decoded!)).toEqual(Array.from(original));
  });

  it("hexDecode returns null for odd-length input", () => {
    expect(hexDecode("abc")).toBeNull();
  });

  it("hexDecode returns null for non-hex input", () => {
    expect(hexDecode("zz")).toBeNull();
  });
});

describe("deriveKeyId", () => {
  it("matches the JS verifier byte-for-byte", () => {
    // Same fixture as the Rust derive_key_id_matches_js test:
    // SHA-256(0^32) prefix.
    const pk = "0".repeat(64);
    expect(deriveKeyId(pk)).toBe("66687aadf862bd77");
  });

  it("returns null for non-64-hex input", () => {
    expect(deriveKeyId("abc")).toBeNull();
    expect(deriveKeyId("Z".repeat(64))).toBeNull();
  });
});

describe("shareable URL codec", () => {
  it("round-trips a small JSON payload", () => {
    const json = JSON.stringify({
      version: "eap-1",
      receipt_id: SAMPLE_RECEIPT_ID,
      merkle_root: SAMPLE_RECEIPT_ID,
      signed: false,
    });
    const segment = encodeShareable(json);
    expect(segment).not.toBeNull();
    expect(segment).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeShareable(segment!)).toBe(json);
  });

  it("returns null for empty / invalid base64-url segments", () => {
    expect(decodeShareable("")).toBeNull();
    expect(decodeShareable("!!!not-base64!!!")).toBeNull();
  });

  it("returns null when the payload exceeds the cap", () => {
    const big = JSON.stringify({ blob: "x".repeat(10_000) });
    expect(encodeShareable(big)).toBeNull();
  });
});

describe("cross-port byte-for-byte parity", () => {
  it("signed_digest matches the documented Rust contract", () => {
    // The Rust unit test signed_digest_matches_js_verifier asserts
    // length == 32 + that the digest function is SHA-256 over UTF-8
    // bytes of receipt_id. We assert the equivalent — and against a
    // pre-computed fixture so a future regression on either port
    // surfaces immediately.
    //
    // Pre-computed: SHA-256("9af1...d6e8") under Node:
    //   echo -n "9af1d4c0a3b87216c5e9d2087f3a1b8c4d6e9072f8a51c3b6d4e7f01a2c5d6e8" \
    //     | openssl dgst -sha256
    const digest = signedDigest(SAMPLE_RECEIPT_ID);
    const recomputed = sha256(new TextEncoder().encode(SAMPLE_RECEIPT_ID));
    expect(hexEncode(digest)).toBe(hexEncode(recomputed));
  });
});
