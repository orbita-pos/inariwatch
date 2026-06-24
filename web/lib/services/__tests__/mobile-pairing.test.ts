/**
 * S12 — mobile-pairing service.
 *
 * Pure-logic tests for SAS derivation + code normalisation +
 * service-layer flow with a mocked Drizzle. We don't drive Postgres
 * here — that's a chaos-suite concern; these tests assert the
 * service's contract surface so the routes can rely on it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock Drizzle ─────────────────────────────────────────────────────

interface Row {
  challengeId:    string;
  workspaceId:    string;
  pairingCode:    string;
  devicePubkey:   string | null;
  displayName:    string | null;
  sasDigits:      string | null;
  sasEmittedAt:   Date | null;
  createdAt:      Date;
  expiresAt:      Date;
  confirmedAt:    Date | null;
  rejectedAt:     Date | null;
  pairedDeviceId: string | null;
}

// Per-test in-memory store of challenges + paired devices.
let challenges: Row[]     = [];
let pairedDevices: Array<{
  deviceId:       string;
  workspaceId:    string;
  devicePubkey:   string;
  displayName:    string;
  pairedAt:       Date;
  lastSeenAt:     Date;
  revokedAt:      Date | null;
  pushSubscription: unknown;
}> = [];

vi.mock("@/lib/db", () => ({
  db: {
    insert: () => insertChain(),
    update: () => updateChain(),
    select: () => selectChain(),
  },
  mobilePairingChallenges: { name: "mobile_pairing_challenges" },
  mobilePairedDevices:     { name: "mobile_paired_devices" },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq:  (col: unknown, val: unknown) => ({ eq: [col, val] }),
  isNull: (col: unknown) => ({ isNull: col }),
}));

vi.mock("@/lib/auth/mobile-jwt", async () => {
  const actual = await vi.importActual<typeof import("../../auth/mobile-jwt")>(
    "../../auth/mobile-jwt",
  );
  return actual;
});

let nextChallengeId = 0;
function uuid(prefix: string): string {
  nextChallengeId += 1;
  const tail = `${nextChallengeId}`.padStart(8, "0");
  return `${prefix}0000-0000-4000-8000-${tail}`;
}

interface InsertReturning {
  values: (vals: Record<string, unknown>) => InsertReturning;
  returning: (fields?: unknown) => Promise<unknown[]>;
}

function insertChain(): { values: (v: Record<string, unknown>) => InsertReturning } {
  let buffered: Record<string, unknown> | null = null;
  let target: "challenges" | "devices" | null = null;
  const ret: InsertReturning = {
    values: (vals: Record<string, unknown>) => {
      buffered = vals;
      return ret;
    },
    returning: async () => {
      if (!buffered) return [];
      // Heuristic: rows with `pairingCode` go into challenges; with
      // `devicePubkey + displayName` (no pairingCode) into devices.
      if ("pairingCode" in buffered) target = "challenges";
      else target = "devices";
      if (target === "challenges") {
        const row: Row = {
          challengeId:    uuid("11111111"),
          workspaceId:    String(buffered.workspaceId ?? ""),
          pairingCode:    String(buffered.pairingCode ?? ""),
          devicePubkey:   null,
          displayName:    null,
          sasDigits:      null,
          sasEmittedAt:   null,
          createdAt:      (buffered.createdAt as Date) ?? new Date(),
          expiresAt:      (buffered.expiresAt as Date) ?? new Date(Date.now() + 3600_000),
          confirmedAt:    null,
          rejectedAt:     null,
          pairedDeviceId: null,
        };
        challenges.push(row);
        return [{ challengeId: row.challengeId }];
      }
      const dev = {
        deviceId:       uuid("22222222"),
        workspaceId:    String(buffered.workspaceId ?? ""),
        devicePubkey:   String(buffered.devicePubkey ?? ""),
        displayName:    String(buffered.displayName ?? ""),
        pairedAt:       new Date(),
        lastSeenAt:     new Date(),
        revokedAt:      null,
        pushSubscription: null,
      };
      pairedDevices.push(dev);
      return [dev];
    },
  };
  return { values: ret.values };
}

function updateChain() {
  let setVals: Record<string, unknown> = {};
  const ret = {
    set: (vals: Record<string, unknown>) => {
      setVals = vals;
      return ret;
    },
    where: async (clause: unknown) => {
      // Heuristic: clause matching `eq(table, val)` carries the id.
      const id = extractIdFromClause(clause);
      if (!id) return;
      // Find in challenges first; if found, update fields.
      const ch = challenges.find((c) => c.challengeId === id);
      if (ch) {
        Object.assign(ch, setVals);
        return;
      }
      const dev = pairedDevices.find((d) => d.deviceId === id);
      if (dev) Object.assign(dev, setVals);
    },
  };
  return ret;
}

function selectChain() {
  let where: unknown = null;
  const ret = {
    from: () => ret,
    where: (clause: unknown) => {
      where = clause;
      return ret;
    },
    limit: async (_n: number) => filter(where),
    then: (resolve: (v: unknown) => void) => resolve(filter(where)),
  };
  return ret;
}

function extractIdFromClause(clause: unknown): string | null {
  if (clause && typeof clause === "object" && "eq" in clause) {
    const arr = (clause as { eq: unknown[] }).eq;
    if (Array.isArray(arr) && arr.length === 2 && typeof arr[1] === "string") return arr[1];
  }
  if (clause && typeof clause === "object" && "and" in clause) {
    const arr = (clause as { and: unknown[] }).and;
    for (const a of arr) {
      const id = extractIdFromClause(a);
      if (id) return id;
    }
  }
  return null;
}

function filter(clause: unknown): unknown[] {
  // Naive filter: try to extract pairingCode / challengeId / deviceId
  // from the clause, return matching rows. Good enough for the unit
  // tests here.
  //
  // Order matters: pairing-code lookups (8-char Crockford strings)
  // must be matched BEFORE generic id extraction, otherwise the eq
  // clause for pairingCode (which carries an 8-char string value)
  // gets intercepted by extractIdFromClause and we fall through to
  // an empty result for the redeem path.
  if (!clause) return [];
  const code = extractPairingCode(clause);
  if (code) {
    return challenges.filter(
      (c) => c.pairingCode === code && !c.confirmedAt && !c.rejectedAt,
    );
  }
  const id = extractIdFromClause(clause);
  if (!id) return [];
  return [
    ...challenges.filter((c) => c.challengeId === id),
    ...pairedDevices.filter((d) => d.deviceId === id),
  ];
}

function extractPairingCode(clause: unknown): string | null {
  if (clause && typeof clause === "object" && "eq" in clause) {
    const arr = (clause as { eq: unknown[] }).eq;
    if (
      Array.isArray(arr) &&
      arr.length === 2 &&
      typeof arr[1] === "string" &&
      /^[A-Z0-9]{8}$/.test(arr[1] as string)
    ) {
      return arr[1] as string;
    }
  }
  if (clause && typeof clause === "object" && "and" in clause) {
    const arr = (clause as { and: unknown[] }).and;
    for (const a of arr) {
      const c = extractPairingCode(a);
      if (c) return c;
    }
  }
  return null;
}

// ── Tests ────────────────────────────────────────────────────────────

import {
  announceChallenge,
  redeemCode,
  confirmChallenge,
  challengeStatus,
  normaliseCode,
  isValidCode,
  deriveSas,
  MobilePairingError,
  SAS_LENGTH,
} from "../mobile-pairing.service";

describe("mobile-pairing — pure helpers", () => {
  it("normaliseCode strips dashes/spaces + uppercases", () => {
    expect(normaliseCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normaliseCode("  abcd efgh ")).toBe("ABCDEFGH");
  });

  it("isValidCode accepts 8-char Crockford strings", () => {
    expect(isValidCode("ABCDEFGH")).toBe(true);
    expect(isValidCode("23456789")).toBe(true);
  });

  it("isValidCode rejects banned letters (0/1/I/L/O/U)", () => {
    expect(isValidCode("0BCDEFGH")).toBe(false);
    expect(isValidCode("1BCDEFGH")).toBe(false);
    expect(isValidCode("IBCDEFGH")).toBe(false);
    expect(isValidCode("LBCDEFGH")).toBe(false);
    expect(isValidCode("OBCDEFGH")).toBe(false);
    expect(isValidCode("UBCDEFGH")).toBe(false);
  });

  it("isValidCode rejects wrong length", () => {
    expect(isValidCode("ABCDEFG")).toBe(false);
    expect(isValidCode("ABCDEFGHJ")).toBe(false);
    expect(isValidCode("")).toBe(false);
  });

  it("deriveSas is deterministic", () => {
    const inputs = {
      pairingCode: "ABCDEFGH",
      identifier:  "abcdef0123456789abcdef0123456789",
      workspaceId: "00000000-0000-4000-8000-000000000000",
      createdAtMs: 1_700_000_000_000,
    };
    const a = deriveSas(inputs);
    const b = deriveSas(inputs);
    expect(a).toBe(b);
    expect(a.length).toBe(SAS_LENGTH);
    expect(/^\d{6}$/.test(a)).toBe(true);
  });

  it("deriveSas changes when any input changes", () => {
    const base = deriveSas({
      pairingCode: "ABCDEFGH",
      identifier:  "id1",
      workspaceId: "ws1",
      createdAtMs: 0,
    });
    expect(base).not.toBe(
      deriveSas({ pairingCode: "HGFEDCBA", identifier: "id1", workspaceId: "ws1", createdAtMs: 0 }),
    );
    expect(base).not.toBe(
      deriveSas({ pairingCode: "ABCDEFGH", identifier: "id2", workspaceId: "ws1", createdAtMs: 0 }),
    );
    expect(base).not.toBe(
      deriveSas({ pairingCode: "ABCDEFGH", identifier: "id1", workspaceId: "ws2", createdAtMs: 0 }),
    );
    expect(base).not.toBe(
      deriveSas({ pairingCode: "ABCDEFGH", identifier: "id1", workspaceId: "ws1", createdAtMs: 1 }),
    );
  });
});

describe("mobile-pairing — service flow", () => {
  beforeEach(() => {
    challenges    = [];
    pairedDevices = [];
    nextChallengeId = 0;
    process.env.MOBILE_DEVICE_JWT_SECRET = "0123456789abcdef".repeat(2);
  });

  it("announceChallenge stores a row with the code", async () => {
    const out = await announceChallenge({
      workspaceId: "ws-1",
      pairingCode: "ABCDEFGH",
      createdAtMs: Date.now(),
    });
    expect(typeof out.challengeId).toBe("string");
    expect(challenges.length).toBe(1);
    expect(challenges[0].pairingCode).toBe("ABCDEFGH");
  });

  it("announceChallenge rejects a malformed code", async () => {
    await expect(
      announceChallenge({
        workspaceId: "ws-1",
        pairingCode: "BAD-CODE",
        createdAtMs: Date.now(),
      }),
    ).rejects.toBeInstanceOf(MobilePairingError);
  });

  it("redeemCode finds the row + derives SAS", async () => {
    const a = await announceChallenge({
      workspaceId: "ws-1",
      pairingCode: "ABCDEFGH",
      createdAtMs: Date.now(),
    });
    const r = await redeemCode({
      code:         "ABCDEFGH",
      devicePubkey: "abcdef0123456789abcdef0123456789",
      displayName:  "Pixel 7",
    });
    expect(r.challengeId).toBe(a.challengeId);
    expect(/^\d{6}$/.test(r.sasDigits)).toBe(true);
    expect(r.displayName).toBe("Pixel 7");
  });

  it("redeemCode rejects unknown code with code_unknown", async () => {
    await expect(
      redeemCode({
        code:         "XXXXXXXX",
        devicePubkey: "abcdef0123456789abcdef0123456789",
        displayName:  "x",
      }),
    ).rejects.toMatchObject({ code: "code_unknown" });
  });

  it("redeemCode rejects expired code with code_expired", async () => {
    await announceChallenge({
      workspaceId: "ws-1",
      pairingCode: "ABCDEFGH",
      createdAtMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_001_000, // expired ~25 years before now
    });
    await expect(
      redeemCode({
        code:         "ABCDEFGH",
        devicePubkey: "abcdef0123456789abcdef0123456789",
        displayName:  "x",
      }),
    ).rejects.toMatchObject({ code: "code_expired" });
  });

  it("redeemCode rejects double-redeem with code_already_redeemed", async () => {
    await announceChallenge({
      workspaceId: "ws-1",
      pairingCode: "ABCDEFGH",
      createdAtMs: Date.now(),
    });
    await redeemCode({
      code:         "ABCDEFGH",
      devicePubkey: "abcdef0123456789abcdef0123456789",
      displayName:  "first",
    });
    await expect(
      redeemCode({
        code:         "ABCDEFGH",
        devicePubkey: "ffffffffffffffffffffffffffffffff",
        displayName:  "second",
      }),
    ).rejects.toMatchObject({ code: "code_already_redeemed" });
  });

  it("confirmChallenge approve=true inserts paired device + signs JWT", async () => {
    const a = await announceChallenge({
      workspaceId: "ws-1",
      pairingCode: "ABCDEFGH",
      createdAtMs: Date.now(),
    });
    await redeemCode({
      code:         "ABCDEFGH",
      devicePubkey: "abcdef0123456789abcdef0123456789",
      displayName:  "Pixel 7",
    });
    const c = await confirmChallenge({ challengeId: a.challengeId, approve: true });
    expect(c.resolved).toBe(true);
    expect(c.device?.displayName).toBe("Pixel 7");
    expect(typeof c.deviceToken).toBe("string");
    expect(c.deviceToken!.split(".").length).toBe(3);
  });

  it("confirmChallenge approve=false rejects the challenge with no device", async () => {
    const a = await announceChallenge({
      workspaceId: "ws-1",
      pairingCode: "ABCDEFGH",
      createdAtMs: Date.now(),
    });
    await redeemCode({
      code:         "ABCDEFGH",
      devicePubkey: "abcdef0123456789abcdef0123456789",
      displayName:  "Pixel 7",
    });
    const c = await confirmChallenge({ challengeId: a.challengeId, approve: false });
    expect(c.resolved).toBe(true);
    expect(c.device).toBeUndefined();
    expect(c.deviceToken).toBeUndefined();
  });

  it("confirmChallenge before redeem returns resolved:false", async () => {
    const a = await announceChallenge({
      workspaceId: "ws-1",
      pairingCode: "ABCDEFGH",
      createdAtMs: Date.now(),
    });
    const c = await confirmChallenge({ challengeId: a.challengeId, approve: true });
    expect(c.resolved).toBe(false);
  });

  it("challengeStatus returns paired:false before confirm", async () => {
    const a = await announceChallenge({
      workspaceId: "ws-1",
      pairingCode: "ABCDEFGH",
      createdAtMs: Date.now(),
    });
    const s = await challengeStatus(a.challengeId);
    expect(s.paired).toBe(false);
  });

  it("challengeStatus returns paired:true + token after confirm", async () => {
    const a = await announceChallenge({
      workspaceId: "ws-1",
      pairingCode: "ABCDEFGH",
      createdAtMs: Date.now(),
    });
    await redeemCode({
      code:         "ABCDEFGH",
      devicePubkey: "abcdef0123456789abcdef0123456789",
      displayName:  "Pixel 7",
    });
    await confirmChallenge({ challengeId: a.challengeId, approve: true });
    const s = await challengeStatus(a.challengeId);
    expect(s.paired).toBe(true);
    expect(typeof s.deviceToken).toBe("string");
    expect(s.device?.displayName).toBe("Pixel 7");
  });
});
