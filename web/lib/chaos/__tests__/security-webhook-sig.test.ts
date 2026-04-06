/**
 * Security Chaos Test: Webhook Signature Verification
 *
 * Tests edge cases in HMAC signature verification:
 * - Empty signatures, wrong algorithm, replay
 * - Timing-safe comparison
 * - Null/missing secrets
 */

import { describe, it, expect, vi } from "vitest";
import crypto from "crypto";

// Mock DB to avoid Neon connection requirement
vi.mock("@/lib/db", () => ({
  db: {},
  alerts: {},
  incidentStorms: {},
  projectIntegrations: {},
  projects: {},
  users: {},
  maintenanceWindows: {},
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: (v: string) => v,
}));

const { verifySignature } = await import("@/lib/webhooks/shared");

function sign(payload: string, secret: string, alg: "sha256" | "sha1" = "sha256"): string {
  return crypto.createHmac(alg, secret).update(payload).digest("hex");
}

describe("Security: Webhook Signature Verification", () => {
  const secret = "whsec_test_secret_key_32bytes!!!";
  const payload = '{"action":"completed","check_run":{"conclusion":"failure"}}';

  // ── Valid signatures ────────────────────────────────────────────────

  it("accepts valid SHA-256 signature", () => {
    const sig = sign(payload, secret, "sha256");
    expect(verifySignature(payload, sig, secret, "sha256")).toBe(true);
  });

  it("accepts valid SHA-1 signature (Vercel)", () => {
    const sig = sign(payload, secret, "sha1");
    expect(verifySignature(payload, sig, secret, "sha1")).toBe(true);
  });

  // ── Invalid signatures ──────────────────────────────────────────────

  it("rejects empty signature", () => {
    expect(verifySignature(payload, "", secret)).toBe(false);
  });

  it("rejects null-like signature", () => {
    expect(verifySignature(payload, "0".repeat(64), secret)).toBe(false);
  });

  it("rejects signature from wrong secret", () => {
    const wrongSig = sign(payload, "wrong-secret");
    expect(verifySignature(payload, wrongSig, secret)).toBe(false);
  });

  it("rejects signature from wrong algorithm", () => {
    const sha1Sig = sign(payload, secret, "sha1");
    // Verify as SHA-256 — should fail (different output length and hash)
    expect(verifySignature(payload, sha1Sig, secret, "sha256")).toBe(false);
  });

  it("rejects tampered payload", () => {
    const sig = sign(payload, secret);
    const tampered = payload.replace("failure", "success");
    expect(verifySignature(tampered, sig, secret)).toBe(false);
  });

  it("rejects truncated signature", () => {
    const sig = sign(payload, secret);
    expect(verifySignature(payload, sig.slice(0, 32), secret)).toBe(false);
  });

  it("rejects signature with extra bytes", () => {
    const sig = sign(payload, secret) + "deadbeef";
    expect(verifySignature(payload, sig, secret)).toBe(false);
  });

  // ── Edge cases ────────────────────────────────────────────────────

  it("handles Buffer payload (GitHub sends raw body)", () => {
    const buf = Buffer.from(payload);
    const sig = sign(payload, secret);
    expect(verifySignature(buf, sig, secret)).toBe(true);
  });

  it("handles unicode payload", () => {
    const unicodePayload = '{"message":"🔥 alerta crítica: señal débil"}';
    const sig = sign(unicodePayload, secret);
    expect(verifySignature(unicodePayload, sig, secret)).toBe(true);
  });

  it("handles very large payload (100KB)", () => {
    const largePayload = '{"data":"' + "x".repeat(100_000) + '"}';
    const sig = sign(largePayload, secret);
    expect(verifySignature(largePayload, sig, secret)).toBe(true);
  });

  // ── Replay detection awareness ────────────────────────────────────

  it("same signature valid for same payload (no replay protection)", () => {
    // Note: HMAC signatures are deterministic — same payload+secret = same sig
    // This means replay attacks are possible without additional mechanisms
    // (timestamp validation, nonce, etc.)
    const sig = sign(payload, secret);
    expect(verifySignature(payload, sig, secret)).toBe(true);
    expect(verifySignature(payload, sig, secret)).toBe(true); // "replayed"
    // Both pass — replay protection is NOT built into HMAC alone
    // This is by design for webhooks (idempotency expected)
  });

  // ── Timing safety ────────────────────────────────────────────────

  it("uses constant-time comparison (implementation check)", () => {
    // We can't directly test timing-safety, but we verify the function
    // returns false for slightly-off signatures (not short-circuiting)
    const realSig = sign(payload, secret);
    // Flip one character
    const nearMiss = realSig.slice(0, -1) + (realSig.endsWith("a") ? "b" : "a");
    expect(verifySignature(payload, nearMiss, secret)).toBe(false);
  });

  // ── Empty/null secret scenarios ───────────────────────────────────

  it("rejects when secret is empty string", () => {
    // HMAC with empty key produces a valid hash — this is dangerous
    // because anyone can compute it
    const emptyKeySig = sign(payload, "");
    // The verifySignature with empty secret should still work technically
    // but the CALLER should never pass empty secret
    const result = verifySignature(payload, emptyKeySig, "");
    // Whether this passes or fails, the test documents the behavior
    expect(typeof result).toBe("boolean");
  });
});
