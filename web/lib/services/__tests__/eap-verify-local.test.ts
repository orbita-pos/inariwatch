/**
 * Tests for verifyReceiptLocally — Fase 11 follow-up.
 *
 * These are pure unit tests: they stub fetch + Redis and exercise the
 * verification state machine. Crypto is NOT stubbed — we use the native
 * Node Ed25519 implementation against real generated keypairs so the
 * test doubles as a contract test against the Rust server's protocol
 * (SHA-256 pre-hash → Ed25519). Rust side is covered in
 * `eap/crates/receipt/src/signing.rs` tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  generateKeyPairSync,
  createHash,
  sign as cryptoSign,
} from "node:crypto";

// ── Silence expected warn/error noise to keep test output readable ─────────
vi.spyOn(console, "log").mockImplementation(() => undefined);
vi.spyOn(console, "warn").mockImplementation(() => undefined);
vi.spyOn(console, "error").mockImplementation(() => undefined);

// ── Redis stub (module-scoped so tests can mutate per case) ────────────────
const redisStore = new Map<string, unknown>();
const redisGetSpy = vi.fn(async (key: string) => redisStore.get(key) ?? null);
const redisSetSpy = vi.fn(async (key: string, value: unknown) => {
  redisStore.set(key, value);
  return "OK" as const;
});

vi.mock("@/lib/redis", () => ({
  getRedis: () => ({
    get: redisGetSpy,
    set: redisSetSpy,
  }),
}));

// ── Drizzle stubs for persistence + sweep ──────────────────────────────────
const dbUpdateSeen: Array<{ set: Record<string, unknown>; where: unknown }> = [];
let dbSelectQueue: unknown[][] = [];

function mkSelectChain() {
  const obj: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "limit", "leftJoin", "innerJoin"]) {
    obj[m] = () => obj;
  }
  obj.then = (resolve: (v: unknown) => void) =>
    resolve(dbSelectQueue.shift() ?? []);
  return obj;
}

function mkUpdateChain() {
  const captured: { set?: Record<string, unknown>; where?: unknown } = {};
  const obj: Record<string, unknown> = {};
  obj.set = (v: Record<string, unknown>) => {
    captured.set = v;
    return obj;
  };
  obj.where = (w: unknown) => {
    captured.where = w;
    dbUpdateSeen.push({ set: captured.set!, where: w });
    return obj;
  };
  obj.then = (resolve: (v: unknown) => void) => resolve(undefined);
  return obj;
}

vi.mock("@/lib/db", () => ({
  db: {
    select: () => mkSelectChain(),
    update: () => mkUpdateChain(),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  eapReceipts: {
    receiptId: "receipt_id",
    signature: "signature",
    verified: "verified",
    verifiedAt: "verified_at",
    createdAt: "created_at",
  },
}));

// ── Helper: build a signed Ed25519 keypair + sign a receipt the same
//    way Rust does (SHA-256 pre-hash → Ed25519) ────────────────────────────
function makeSignedReceipt(opts: { receiptId?: string } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubkeyDer = publicKey.export({ format: "der", type: "spki" });
  // Extract the raw 32-byte pubkey from the SPKI DER wrapper.
  // SPKI for Ed25519: 30 2a 30 05 06 03 2b 65 70 03 21 00 <32-byte pubkey>
  const rawPubkey = pubkeyDer.subarray(pubkeyDer.length - 32);
  const pubkeyHex = rawPubkey.toString("hex");

  const receiptId =
    opts.receiptId ?? "a".repeat(64); // 32-byte hex merkle root
  const digest = createHash("sha256").update(receiptId, "utf8").digest();
  const signature = cryptoSign(null, digest, privateKey);
  const signatureHex = signature.toString("hex");

  return { receiptId, signatureHex, pubkeyHex };
}

const VALID_ATTESTOR_RESPONSE = (pubkeyHex: string) => ({
  key_available: true,
  public_key: pubkeyHex,
  key_id: createHash("sha256")
    .update(Buffer.from(pubkeyHex, "hex"))
    .digest()
    .subarray(0, 8)
    .toString("hex"),
  attestor_name: "inariwatch",
  algorithm: "ed25519",
});

function mockFetch(response: unknown, status = 200): void {
  globalThis.fetch = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => response,
  })) as unknown as typeof fetch;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("verifyReceiptLocally", () => {
  beforeEach(() => {
    redisStore.clear();
    redisGetSpy.mockClear();
    redisSetSpy.mockClear();
    dbUpdateSeen.length = 0;
    dbSelectQueue = [];
    process.env.EAP_LOCAL_VERIFY_ENABLED = "true";
    process.env.EAP_SERVER_URL = "http://eap.test";
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.EAP_LOCAL_VERIFY_ENABLED;
    delete process.env.EAP_SERVER_URL;
  });

  it("returns verified=true on valid signature + matching pubkey", async () => {
    const { receiptId, signatureHex, pubkeyHex } = makeSignedReceipt();
    mockFetch(VALID_ATTESTOR_RESPONSE(pubkeyHex));
    const { verifyReceiptLocally } = await import(
      "@/lib/services/eap-verify-local"
    );

    const result = await verifyReceiptLocally({
      receiptId,
      signatureHex,
      publicKeyHex: pubkeyHex,
    });

    expect(result.verified).toBe(true);
    if (result.verified) {
      expect(result.keyId).toMatch(/^[0-9a-f]{16}$/);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns verified=false, reason=disabled when flag is off", async () => {
    process.env.EAP_LOCAL_VERIFY_ENABLED = "false";
    const { receiptId, signatureHex, pubkeyHex } = makeSignedReceipt();
    const { verifyReceiptLocally } = await import(
      "@/lib/services/eap-verify-local"
    );

    const result = await verifyReceiptLocally({
      receiptId,
      signatureHex,
      publicKeyHex: pubkeyHex,
    });
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.reason).toBe("disabled");
  });

  it("returns reason=eap-not-configured when EAP_SERVER_URL unset", async () => {
    delete process.env.EAP_SERVER_URL;
    const { receiptId, signatureHex, pubkeyHex } = makeSignedReceipt();
    const { verifyReceiptLocally } = await import(
      "@/lib/services/eap-verify-local"
    );

    const result = await verifyReceiptLocally({
      receiptId,
      signatureHex,
      publicKeyHex: pubkeyHex,
    });
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.reason).toBe("eap-not-configured");
  });

  it("returns reason=unsigned when signatureHex is null", async () => {
    const { receiptId, pubkeyHex } = makeSignedReceipt();
    mockFetch(VALID_ATTESTOR_RESPONSE(pubkeyHex));
    const { verifyReceiptLocally } = await import(
      "@/lib/services/eap-verify-local"
    );

    const result = await verifyReceiptLocally({
      receiptId,
      signatureHex: null,
      publicKeyHex: pubkeyHex,
    });
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.reason).toBe("unsigned");
  });

  it("returns reason=malformed when receipt_id length is wrong", async () => {
    const { signatureHex, pubkeyHex } = makeSignedReceipt();
    mockFetch(VALID_ATTESTOR_RESPONSE(pubkeyHex));
    const { verifyReceiptLocally } = await import(
      "@/lib/services/eap-verify-local"
    );

    const result = await verifyReceiptLocally({
      receiptId: "shortid",
      signatureHex,
      publicKeyHex: pubkeyHex,
    });
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.reason).toBe("malformed");
  });

  it("returns reason=malformed when signatureHex length is wrong", async () => {
    const { receiptId, pubkeyHex } = makeSignedReceipt();
    mockFetch(VALID_ATTESTOR_RESPONSE(pubkeyHex));
    const { verifyReceiptLocally } = await import(
      "@/lib/services/eap-verify-local"
    );

    const result = await verifyReceiptLocally({
      receiptId,
      signatureHex: "ab".repeat(10), // 20 chars, not 128
      publicKeyHex: pubkeyHex,
    });
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.reason).toBe("malformed");
  });

  it("returns reason=attestor-unavailable when server has no key loaded", async () => {
    const { receiptId, signatureHex, pubkeyHex } = makeSignedReceipt();
    mockFetch({
      key_available: false,
      public_key: null,
      key_id: null,
      attestor_name: null,
      algorithm: "ed25519",
    });
    const { verifyReceiptLocally } = await import(
      "@/lib/services/eap-verify-local"
    );

    const result = await verifyReceiptLocally({
      receiptId,
      signatureHex,
      publicKeyHex: pubkeyHex,
    });
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.reason).toBe("attestor-unavailable");
  });

  it("returns reason=attestor-fetch-failed on network error", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const { receiptId, signatureHex, pubkeyHex } = makeSignedReceipt();
    const { verifyReceiptLocally } = await import(
      "@/lib/services/eap-verify-local"
    );

    const result = await verifyReceiptLocally({
      receiptId,
      signatureHex,
      publicKeyHex: pubkeyHex,
    });
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.reason).toBe("attestor-fetch-failed");
  });

  it("returns reason=pubkey-mismatch when receipt pubkey != pinned", async () => {
    const { receiptId, signatureHex, pubkeyHex } = makeSignedReceipt();
    // Server returns a DIFFERENT pubkey than what the receipt carried.
    const otherKp = makeSignedReceipt();
    mockFetch(VALID_ATTESTOR_RESPONSE(otherKp.pubkeyHex));
    const { verifyReceiptLocally } = await import(
      "@/lib/services/eap-verify-local"
    );

    const result = await verifyReceiptLocally({
      receiptId,
      signatureHex,
      publicKeyHex: pubkeyHex,
    });
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.reason).toBe("pubkey-mismatch");
  });

  it("returns reason=signature-invalid when sig is valid hex but wrong bytes", async () => {
    const { receiptId, pubkeyHex } = makeSignedReceipt();
    mockFetch(VALID_ATTESTOR_RESPONSE(pubkeyHex));
    const { verifyReceiptLocally } = await import(
      "@/lib/services/eap-verify-local"
    );

    const result = await verifyReceiptLocally({
      receiptId,
      signatureHex: "ab".repeat(64), // 128 hex chars, but random bytes
      publicKeyHex: pubkeyHex,
    });
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.reason).toBe("signature-invalid");
  });

  it("caches the attestor info in Redis on first fetch", async () => {
    const { receiptId, signatureHex, pubkeyHex } = makeSignedReceipt();
    mockFetch(VALID_ATTESTOR_RESPONSE(pubkeyHex));
    const { verifyReceiptLocally } = await import(
      "@/lib/services/eap-verify-local"
    );

    await verifyReceiptLocally({
      receiptId,
      signatureHex,
      publicKeyHex: pubkeyHex,
    });

    expect(redisSetSpy).toHaveBeenCalledTimes(1);
    const [key, value] = redisSetSpy.mock.calls[0]!;
    expect(String(key)).toContain("eap:attestor:current:");
    expect((value as { keyAvailable: boolean }).keyAvailable).toBe(true);
  });

  it("reuses the Redis cache on a second call (no second fetch)", async () => {
    const { receiptId, signatureHex, pubkeyHex } = makeSignedReceipt();
    mockFetch(VALID_ATTESTOR_RESPONSE(pubkeyHex));
    const { verifyReceiptLocally } = await import(
      "@/lib/services/eap-verify-local"
    );

    await verifyReceiptLocally({
      receiptId,
      signatureHex,
      publicKeyHex: pubkeyHex,
    });
    const fetchSpy = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
    const firstCallCount = fetchSpy.mock.calls.length;

    await verifyReceiptLocally({
      receiptId,
      signatureHex,
      publicKeyHex: pubkeyHex,
    });
    expect(fetchSpy.mock.calls.length).toBe(firstCallCount); // no new fetch
  });
});

describe("recomputeMerkleRoot", () => {
  it("returns 32 zero bytes (64 hex chars) for an empty event list", async () => {
    const { recomputeMerkleRoot } = await import(
      "@/lib/services/eap-verify-local"
    );
    const root = recomputeMerkleRoot([]);
    expect(root).toBe("0".repeat(64));
  });

  it("is deterministic for the same input", async () => {
    const { recomputeMerkleRoot } = await import(
      "@/lib/services/eap-verify-local"
    );
    const events = [
      { a: 1, b: 2 },
      { c: 3 },
      { d: { nested: [1, 2, 3] } },
    ];
    expect(recomputeMerkleRoot(events)).toBe(recomputeMerkleRoot(events));
  });

  it("ignores object key insertion order (canonical JSON)", async () => {
    const { recomputeMerkleRoot } = await import(
      "@/lib/services/eap-verify-local"
    );
    const a = [{ a: 1, b: 2 }];
    const b = [{ b: 2, a: 1 }];
    expect(recomputeMerkleRoot(a)).toBe(recomputeMerkleRoot(b));
  });

  it("produces different roots for different content", async () => {
    const { recomputeMerkleRoot } = await import(
      "@/lib/services/eap-verify-local"
    );
    const a = [{ a: 1 }];
    const b = [{ a: 2 }];
    expect(recomputeMerkleRoot(a)).not.toBe(recomputeMerkleRoot(b));
  });
});

describe("deriveKeyId", () => {
  it("produces a 16 hex-char id from a valid pubkey", async () => {
    const { deriveKeyId } = await import("@/lib/services/eap-verify-local");
    const id = deriveKeyId("ab".repeat(32));
    expect(id).not.toBeNull();
    expect(id!.length).toBe(16);
    expect(id!).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns null for malformed pubkey hex", async () => {
    const { deriveKeyId } = await import("@/lib/services/eap-verify-local");
    expect(deriveKeyId("not-hex")).toBeNull();
    expect(deriveKeyId("ab".repeat(31))).toBeNull(); // 62 chars
  });
});

describe("persistVerificationOutcome", () => {
  beforeEach(() => {
    dbUpdateSeen.length = 0;
    process.env.EAP_LOCAL_VERIFY_ENABLED = "true";
    process.env.EAP_SERVER_URL = "http://eap.test";
    vi.resetModules();
  });

  it("writes verified=true with a timestamp for a successful verdict", async () => {
    const { persistVerificationOutcome } = await import(
      "@/lib/services/eap-verify-local"
    );
    await persistVerificationOutcome("a".repeat(64), {
      verified: true,
      keyId: "abcdef0123456789",
      durationMs: 5,
    });
    expect(dbUpdateSeen).toHaveLength(1);
    expect(dbUpdateSeen[0]!.set.verified).toBe(true);
    expect(dbUpdateSeen[0]!.set.verifiedAt).toBeInstanceOf(Date);
  });

  it("writes verified=false for non-transient failures (signature-invalid)", async () => {
    const { persistVerificationOutcome } = await import(
      "@/lib/services/eap-verify-local"
    );
    await persistVerificationOutcome("a".repeat(64), {
      verified: false,
      reason: "signature-invalid",
      durationMs: 3,
    });
    expect(dbUpdateSeen).toHaveLength(1);
    expect(dbUpdateSeen[0]!.set.verified).toBe(false);
  });

  it("writes verified=false for merkle-mismatch (persistable)", async () => {
    const { persistVerificationOutcome } = await import(
      "@/lib/services/eap-verify-local"
    );
    await persistVerificationOutcome("a".repeat(64), {
      verified: false,
      reason: "merkle-mismatch",
      durationMs: 12,
    });
    expect(dbUpdateSeen).toHaveLength(1);
    expect(dbUpdateSeen[0]!.set.verified).toBe(false);
  });

  it.each([
    "disabled",
    "eap-not-configured",
    "attestor-unavailable",
    "attestor-fetch-failed",
  ] as const)(
    "does NOT persist transient reason %s",
    async (reason) => {
      const { persistVerificationOutcome } = await import(
        "@/lib/services/eap-verify-local"
      );
      await persistVerificationOutcome("a".repeat(64), {
        verified: false,
        reason,
        durationMs: 1,
      });
      expect(dbUpdateSeen).toHaveLength(0);
    },
  );
});

describe("sweepUnverifiedReceipts", () => {
  beforeEach(() => {
    dbSelectQueue = [];
    dbUpdateSeen.length = 0;
    redisStore.clear();
    process.env.EAP_LOCAL_VERIFY_ENABLED = "true";
    process.env.EAP_SERVER_URL = "http://eap.test";
    vi.resetModules();
  });

  it("returns zero stats when feature flag is off (no DB query)", async () => {
    process.env.EAP_LOCAL_VERIFY_ENABLED = "false";
    const { sweepUnverifiedReceipts } = await import(
      "@/lib/services/eap-verify-local"
    );
    const stats = await sweepUnverifiedReceipts();
    expect(stats.scanned).toBe(0);
    expect(stats.verified).toBe(0);
    expect(dbSelectQueue).toHaveLength(0); // wasn't consumed
    expect(dbUpdateSeen).toHaveLength(0);
  });

  it("returns zero stats when EAP_SERVER_URL is unset", async () => {
    delete process.env.EAP_SERVER_URL;
    const { sweepUnverifiedReceipts } = await import(
      "@/lib/services/eap-verify-local"
    );
    const stats = await sweepUnverifiedReceipts();
    expect(stats.scanned).toBe(0);
  });

  it("processes a batch of unverified receipts end-to-end", async () => {
    const { receiptId, signatureHex, pubkeyHex } = makeSignedReceipt();
    mockFetch(VALID_ATTESTOR_RESPONSE(pubkeyHex));
    dbSelectQueue = [
      [
        { receiptId, signature: signatureHex },
        { receiptId: "b".repeat(64), signature: "deadbeef".repeat(16) }, // bogus sig
      ],
    ];

    const { sweepUnverifiedReceipts } = await import(
      "@/lib/services/eap-verify-local"
    );
    const stats = await sweepUnverifiedReceipts({ batchSize: 50 });

    expect(stats.scanned).toBe(2);
    expect(stats.verified).toBe(1);
    expect(stats.failed).toBe(1);
    // Both rows attempted persist; bogus-sig path hits signature-invalid
    // which IS persistable. So 2 updates total.
    expect(dbUpdateSeen).toHaveLength(2);
  });

  it("skips rows with null signature", async () => {
    const { pubkeyHex } = makeSignedReceipt();
    mockFetch(VALID_ATTESTOR_RESPONSE(pubkeyHex));
    dbSelectQueue = [
      [{ receiptId: "c".repeat(64), signature: null }],
    ];
    const { sweepUnverifiedReceipts } = await import(
      "@/lib/services/eap-verify-local"
    );
    const stats = await sweepUnverifiedReceipts();
    expect(stats.scanned).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(stats.verified).toBe(0);
    expect(stats.failed).toBe(0);
    expect(dbUpdateSeen).toHaveLength(0);
  });
});

describe("verifyAndPersist", () => {
  beforeEach(() => {
    dbUpdateSeen.length = 0;
    redisStore.clear();
    redisGetSpy.mockClear();
    redisSetSpy.mockClear();
    process.env.EAP_LOCAL_VERIFY_ENABLED = "true";
    process.env.EAP_SERVER_URL = "http://eap.test";
    vi.resetModules();
  });

  it("verifies + writes verified=true for a valid signature", async () => {
    const { receiptId, signatureHex, pubkeyHex } = makeSignedReceipt();
    mockFetch(VALID_ATTESTOR_RESPONSE(pubkeyHex));

    const { verifyAndPersist } = await import(
      "@/lib/services/eap-verify-local"
    );
    const result = await verifyAndPersist({
      receiptId,
      signatureHex,
      publicKeyHex: pubkeyHex,
    });

    expect(result.verified).toBe(true);
    expect(dbUpdateSeen).toHaveLength(1);
    expect(dbUpdateSeen[0]!.set.verified).toBe(true);
  });
});
