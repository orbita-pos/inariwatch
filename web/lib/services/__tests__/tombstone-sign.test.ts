/**
 * Tests for the tombstone signing primitive (Track E pieza 11).
 *
 * Round-trips against the verify endpoint's expected protocol:
 *   tombstone_id = hex(SHA-256(canonical_json(content)))
 *   sig          = "ed25519:" + hex(ed25519_sign(SHA-256(tombstone_id_utf8)))
 *
 * Crypto is NOT stubbed — we use Node's native Ed25519 against a
 * deterministic test key so the test doubles as a contract test for the
 * verify endpoint's verifyEd25519Signature consumer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash, generateKeyPairSync } from "node:crypto";

vi.spyOn(console, "error").mockImplementation(() => undefined);

/** Build a fresh Ed25519 keypair and return the 32-byte secret hex —
 *  same format INARIWATCH_TOMBSTONE_KEY_HEX expects. */
function freshSecretHex(): { secretHex: string; pubkeyHex: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  // Extract raw 32-byte secret from PKCS#8 (last 32 bytes after the
  // fixed ed25519 prefix).
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  const secretBytes = pkcs8.subarray(pkcs8.length - 32);
  const spki = publicKey.export({ format: "der", type: "spki" });
  const pubkeyBytes = spki.subarray(spki.length - 32);
  return {
    secretHex: secretBytes.toString("hex"),
    pubkeyHex: pubkeyBytes.toString("hex"),
  };
}

describe("signTombstone", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.INARIWATCH_TOMBSTONE_KEY_HEX;
  });

  afterEach(() => {
    delete process.env.INARIWATCH_TOMBSTONE_KEY_HEX;
  });

  it("returns key-unavailable when env is unset", async () => {
    const { signTombstone } = await import("@/lib/services/tombstone-sign");
    const result = signTombstone({
      fingerprint: "fp",
      integrationId: "00000000-0000-0000-0000-000000000000",
      processedActions: ["analyzed"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("key-unavailable");
  });

  it("returns key-unavailable for malformed env hex", async () => {
    process.env.INARIWATCH_TOMBSTONE_KEY_HEX = "not-hex";
    const { signTombstone } = await import("@/lib/services/tombstone-sign");
    const result = signTombstone({
      fingerprint: "fp",
      integrationId: "00000000-0000-0000-0000-000000000000",
      processedActions: ["analyzed"],
    });
    expect(result.ok).toBe(false);
  });

  it("produces a tombstone whose tombstone_id matches canonical hash", async () => {
    const { secretHex } = freshSecretHex();
    process.env.INARIWATCH_TOMBSTONE_KEY_HEX = secretHex;

    const { signTombstone, canonicalJsonStringify } = await import(
      "@/lib/services/tombstone-sign"
    );

    const result = signTombstone({
      fingerprint: "abc123",
      integrationId: "11111111-2222-3333-4444-555555555555",
      processedActions: ["notified", "analyzed"],
      ts: "2026-04-25T12:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const t = result.tombstone;

    expect(t.v).toBe(1);
    expect(t.processed_actions).toEqual(["analyzed", "notified"]); // sorted
    expect(t.fingerprint_hash).toBe(
      createHash("sha256").update("abc123", "utf8").digest("hex"),
    );
    expect(t.key_id).toMatch(/^[0-9a-f]{16}$/);
    expect(t.tombstone_id).toMatch(/^[0-9a-f]{64}$/);
    expect(t.sig).toMatch(/^ed25519:[0-9a-f]{128}$/);
    expect(t.pubkey).toMatch(/^[0-9a-f]{64}$/);

    // Recompute canonical hash and ensure it matches tombstone_id.
    const content = {
      v: t.v,
      ts: t.ts,
      fingerprint_hash: t.fingerprint_hash,
      processed_actions: t.processed_actions,
      integration_id: t.integration_id,
      key_id: t.key_id,
    };
    const recomputed = createHash("sha256")
      .update(canonicalJsonStringify(content), "utf8")
      .digest("hex");
    expect(recomputed).toBe(t.tombstone_id);
  });

  it("signature verifies against verifyEd25519Signature (round-trip)", async () => {
    const { secretHex } = freshSecretHex();
    process.env.INARIWATCH_TOMBSTONE_KEY_HEX = secretHex;

    const { signTombstone, getTombstoneAttestorInfo } = await import(
      "@/lib/services/tombstone-sign"
    );
    const { verifyEd25519Signature } = await import(
      "@/lib/services/eap-verify-local"
    );

    const r = signTombstone({
      fingerprint: "fp",
      integrationId: "11111111-2222-3333-4444-555555555555",
      processedActions: ["analyzed", "notified"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const attestor = getTombstoneAttestorInfo();
    expect(attestor.keyAvailable).toBe(true);
    expect(attestor.publicKey).toBe(r.tombstone.pubkey);

    const sigHex = r.tombstone.sig.replace(/^ed25519:/, "");
    const verified = verifyEd25519Signature({
      receiptId: r.tombstone.tombstone_id,
      signatureHex: sigHex,
      publicKeyHex: attestor.publicKey!,
    });
    expect(verified).toBe(true);
  });

  it("rejects a tampered tombstone (mutated processed_actions)", async () => {
    const { secretHex } = freshSecretHex();
    process.env.INARIWATCH_TOMBSTONE_KEY_HEX = secretHex;

    const { signTombstone, canonicalJsonStringify } = await import(
      "@/lib/services/tombstone-sign"
    );
    const { verifyEd25519Signature } = await import(
      "@/lib/services/eap-verify-local"
    );

    const r = signTombstone({
      fingerprint: "fp",
      integrationId: "11111111-2222-3333-4444-555555555555",
      processedActions: ["analyzed"],
    });
    if (!r.ok) throw new Error("sign failed");

    // Mutate processed_actions; recompute id/canonical with the
    // mutated content; ensure the original sig no longer verifies.
    const tampered = {
      v: r.tombstone.v,
      ts: r.tombstone.ts,
      fingerprint_hash: r.tombstone.fingerprint_hash,
      processed_actions: ["analyzed", "notified"], // adversarial — claim we notified
      integration_id: r.tombstone.integration_id,
      key_id: r.tombstone.key_id,
    };
    const tamperedId = createHash("sha256")
      .update(canonicalJsonStringify(tampered), "utf8")
      .digest("hex");

    const sigHex = r.tombstone.sig.replace(/^ed25519:/, "");
    const verified = verifyEd25519Signature({
      receiptId: tamperedId,
      signatureHex: sigHex,
      publicKeyHex: r.tombstone.pubkey,
    });
    expect(verified).toBe(false);
  });

  it("getTombstoneAttestorInfo reflects key availability", async () => {
    {
      const { getTombstoneAttestorInfo } = await import(
        "@/lib/services/tombstone-sign"
      );
      const info = getTombstoneAttestorInfo();
      expect(info.keyAvailable).toBe(false);
      expect(info.publicKey).toBeNull();
      expect(info.algorithm).toBe("ed25519");
    }

    vi.resetModules();
    process.env.INARIWATCH_TOMBSTONE_KEY_HEX = freshSecretHex().secretHex;
    {
      const { getTombstoneAttestorInfo } = await import(
        "@/lib/services/tombstone-sign"
      );
      const info = getTombstoneAttestorInfo();
      expect(info.keyAvailable).toBe(true);
      expect(info.publicKey).toMatch(/^[0-9a-f]{64}$/);
      expect(info.keyId).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});
