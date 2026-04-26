/**
 * Tests for verifyCaptureV2Payload — Track A piece 17 (server side).
 *
 * Symmetry test: a payload signed by the SDK's `signing.ts` must verify
 * here without protocol fork. We don't import capture/ at runtime (tests
 * shouldn't depend on the dist/ build) — instead we replicate the SDK's
 * sign step inline using node:crypto, which is the actual primitive both
 * sides use.
 */

import { describe, it, expect } from "vitest";
import {
  generateKeyPairSync,
  createHash,
  sign as cryptoSign,
} from "node:crypto";
import { verifyCaptureV2Payload } from "../capture-v2-verify";

// Replicates `signing.ts.signReceiptId` — Ed25519 over SHA-256(receipt_id_hex).
function signReceiptId(receiptIdHex: string, privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]) {
  const digest = createHash("sha256").update(receiptIdHex, "utf8").digest();
  return cryptoSign(null, digest, privateKey).toString("hex");
}

// Mirrors `payload-v2.ts.canonicalJsonStringify` — needed so test-side
// recompute matches server-side recompute.
function canonicalJsonStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value ?? null);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`).join(",")}}`;
}

function computeRoot(evidence: unknown): string {
  const canonical = canonicalJsonStringify(evidence);
  const leaf = createHash("sha256").update(canonical, "utf8").digest();
  return createHash("sha256").update(leaf).update(leaf).digest("hex");
}

function makeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  const pubBytes = Buffer.from(jwk.x!, "base64url");
  const publicKeyHex = pubBytes.toString("hex");
  const pubKeyId = createHash("sha256").update(pubBytes).digest("hex").slice(0, 16);
  return { privateKey, publicKeyHex, pubKeyId };
}

function makeEvidence() {
  return {
    stack: [
      { file: "/app/server.ts", line: 42, function: "handler", tokens_estimated: 12 },
    ],
    tokens_estimated_total: 25,
  };
}

describe("verifyCaptureV2Payload", () => {
  it("accepts a well-signed v2 payload", () => {
    const kp = makeKeypair();
    const evidence = makeEvidence();
    const root = computeRoot(evidence);
    const sig = signReceiptId(root, kp.privateKey);

    const payload = {
      schema_version: "2.0",
      fingerprint: "f".repeat(64),
      title: "X",
      severity: "critical",
      timestamp: "2026-04-25T12:00:00Z",
      evidence,
      hypotheses: [],
      signature: {
        alg: "ed25519",
        pub_key_id: kp.pubKeyId,
        signer_pubkey: kp.publicKeyHex,
        evidence_merkle_root: root,
        sig,
        signed_at: "2026-04-25T12:00:00Z",
      },
    };

    const r = verifyCaptureV2Payload(payload);
    expect(r.verified).toBe(true);
    if (r.verified) {
      expect(r.receiptId).toBe(root);
      expect(r.pubKeyId).toBe(kp.pubKeyId);
      expect(r.signerPubkey).toBe(kp.publicKeyHex);
    }
  });

  it("rejects v1 payloads (schema_version missing)", () => {
    const r = verifyCaptureV2Payload({ fingerprint: "x", title: "y" });
    expect(r).toEqual({ verified: false, reason: "not-v2" });
  });

  it("rejects v2 payload without signature block", () => {
    const r = verifyCaptureV2Payload({
      schema_version: "2.0",
      evidence: makeEvidence(),
    });
    expect(r).toEqual({ verified: false, reason: "missing-signature" });
  });

  it("rejects malformed signature (wrong sig length)", () => {
    const kp = makeKeypair();
    const r = verifyCaptureV2Payload({
      schema_version: "2.0",
      evidence: makeEvidence(),
      signature: {
        alg: "ed25519",
        pub_key_id: kp.pubKeyId,
        signer_pubkey: kp.publicKeyHex,
        evidence_merkle_root: "0".repeat(64),
        sig: "ab",
        signed_at: "2026-04-25T12:00:00Z",
      },
    });
    expect(r).toEqual({ verified: false, reason: "malformed-signature" });
  });

  it("rejects when the merkle root doesn't match recomputed evidence", () => {
    const kp = makeKeypair();
    const evidence = makeEvidence();
    const claimedRoot = "0".repeat(64);
    const sig = signReceiptId(claimedRoot, kp.privateKey);
    const r = verifyCaptureV2Payload({
      schema_version: "2.0",
      evidence,
      signature: {
        alg: "ed25519",
        pub_key_id: kp.pubKeyId,
        signer_pubkey: kp.publicKeyHex,
        evidence_merkle_root: claimedRoot,
        sig,
        signed_at: "2026-04-25T12:00:00Z",
      },
    });
    expect(r).toEqual({ verified: false, reason: "merkle-mismatch" });
  });

  it("rejects a tampered signature on otherwise-valid payload", () => {
    const kp = makeKeypair();
    const evidence = makeEvidence();
    const root = computeRoot(evidence);
    const sig = signReceiptId(root, kp.privateKey);
    // Flip one nibble in the signature.
    const tampered = sig.slice(0, -2) + (sig.slice(-2) === "00" ? "ff" : "00");
    const r = verifyCaptureV2Payload({
      schema_version: "2.0",
      evidence,
      signature: {
        alg: "ed25519",
        pub_key_id: kp.pubKeyId,
        signer_pubkey: kp.publicKeyHex,
        evidence_merkle_root: root,
        sig: tampered,
        signed_at: "2026-04-25T12:00:00Z",
      },
    });
    expect(r).toEqual({ verified: false, reason: "signature-invalid" });
  });

  it("rejects when pub_key_id doesn't match SHA-256(pubkey)[:16]", () => {
    const kp = makeKeypair();
    const evidence = makeEvidence();
    const root = computeRoot(evidence);
    const sig = signReceiptId(root, kp.privateKey);
    const r = verifyCaptureV2Payload({
      schema_version: "2.0",
      evidence,
      signature: {
        alg: "ed25519",
        pub_key_id: "0123456789abcdef", // wrong
        signer_pubkey: kp.publicKeyHex,
        evidence_merkle_root: root,
        sig,
        signed_at: "2026-04-25T12:00:00Z",
      },
    });
    expect(r.verified).toBe(false);
    if (!r.verified) expect(r.reason).toBe("malformed-signature");
  });
});
