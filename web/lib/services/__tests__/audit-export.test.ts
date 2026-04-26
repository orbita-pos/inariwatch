/**
 * Tests for buildAuditExport — pure unit, DB stubbed. Verifies:
 *
 *   1. Standards are correctly mapped (each receipt carries the chosen
 *      standard's controls in its manifest entry).
 *   2. The bundle is a valid ZIP whose entries we can extract by hand.
 *   3. manifest.json has the attestor pubkey + verification recipe an
 *      auditor needs to re-verify offline.
 *   4. Date-range guards reject obviously invalid input at the service
 *      layer (the API also enforces but the service should be safe in
 *      isolation).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.spyOn(console, "log").mockImplementation(() => undefined);
vi.spyOn(console, "warn").mockImplementation(() => undefined);
vi.spyOn(console, "error").mockImplementation(() => undefined);

// ── DB mock plumbing ──────────────────────────────────────────────────────
//
// The service uses 4 select chains:
//   - resolveProjectIds → projects
//   - loadReceipts → eapReceipts JOIN alerts JOIN projects LEFT JOIN remediation_sessions
//   - loadOrgName → organizations (only when organizationId !== null)
//   - isExportAllowedForUser / isOrgMember (only used by tests for those helpers)
//
// We feed a queue of result arrays and let drizzle's chained calls drop
// through transparently to a thenable.
let dbSelectQueue: unknown[][] = [];

function mkSelectChain() {
  const obj: Record<string, unknown> = {};
  for (const m of [
    "from",
    "where",
    "orderBy",
    "limit",
    "leftJoin",
    "innerJoin",
  ]) {
    obj[m] = () => obj;
  }
  obj.then = (resolve: (v: unknown) => void) =>
    resolve(dbSelectQueue.shift() ?? []);
  return obj;
}

vi.mock("@/lib/db", () => ({
  db: { select: () => mkSelectChain() },
}));

// Schema mock — bare column markers; the real types only matter to the
// drizzle query builder, which we're mocking out anyway.
vi.mock("@/lib/db/schema", () => ({
  eapReceipts: {
    receiptId: "receipt_id",
    merkleRoot: "merkle_root",
    signature: "signature",
    signed: "signed",
    eventCount: "event_count",
    attestor: "attestor",
    verified: "verified",
    verifiedAt: "verified_at",
    createdAt: "created_at",
    alertId: "alert_id",
    remediationSessionId: "remediation_session_id",
  },
  alerts: {
    id: "id",
    title: "title",
    severity: "severity",
    fingerprint: "fingerprint",
    createdAt: "created_at",
    projectId: "project_id",
  },
  projects: {
    id: "id",
    name: "name",
    slug: "slug",
    userId: "user_id",
    organizationId: "organization_id",
  },
  remediationSessions: {
    id: "id",
    prUrl: "pr_url",
    mergedCommitSha: "merged_commit_sha",
    confidenceScore: "confidence_score",
  },
  organizations: { id: "id", name: "name", ownerId: "owner_id" },
  organizationMembers: {
    id: "id",
    organizationId: "organization_id",
    userId: "user_id",
  },
  users: { id: "id", plan: "plan" },
}));

// Stub the EAP attestor lookup so tests don't try to hit a network.
vi.mock("@/lib/services/eap-verify-local", () => ({
  getAttestorInfo: vi.fn(async () => ({
    keyAvailable: true,
    publicKey: "11".repeat(32),
    keyId: "0123456789abcdef",
    attestorName: "inariwatch",
    algorithm: "ed25519",
  })),
}));

// ── Helpers shared with the ZIP smoke test (re-implemented locally so
//    the audit-export tests can run independently). ────────────────────────

function readUint32LE(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset + offset, 4).getUint32(0, true);
}
function readUint16LE(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset + offset, 2).getUint16(0, true);
}

function findEocd(zip: Uint8Array): number {
  for (let i = zip.byteLength - 22; i >= 0; i--) {
    if (readUint32LE(zip, i) === 0x06054b50) return i;
  }
  throw new Error("EOCD not found");
}

function extractZip(zip: Uint8Array): Map<string, Uint8Array> {
  const eocdOffset = findEocd(zip);
  const totalEntries = readUint16LE(zip, eocdOffset + 10);
  const centralOffset = readUint32LE(zip, eocdOffset + 16);

  const out = new Map<string, Uint8Array>();
  let cursor = centralOffset;
  for (let i = 0; i < totalEntries; i++) {
    const uncompSize = readUint32LE(zip, cursor + 24);
    const nameLen = readUint16LE(zip, cursor + 28);
    const extraLen = readUint16LE(zip, cursor + 30);
    const commentLen = readUint16LE(zip, cursor + 32);
    const localHeaderOff = readUint32LE(zip, cursor + 42);
    const path = new TextDecoder("utf-8").decode(
      zip.subarray(cursor + 46, cursor + 46 + nameLen),
    );

    const localNameLen = readUint16LE(zip, localHeaderOff + 26);
    const localExtraLen = readUint16LE(zip, localHeaderOff + 28);
    const dataStart = localHeaderOff + 30 + localNameLen + localExtraLen;
    out.set(path, zip.slice(dataStart, dataStart + uncompSize));

    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function utf8(b: Uint8Array): string {
  return new TextDecoder("utf-8").decode(b);
}

// ── Fixtures ──────────────────────────────────────────────────────────────

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const ALERT_ID = "22222222-2222-2222-2222-222222222222";
const REMED_ID = "33333333-3333-3333-3333-333333333333";

function makeReceipt(idx: number, signed: boolean) {
  return {
    receiptId: idx.toString(16).padStart(64, "0"),
    merkleRoot: idx.toString(16).padStart(64, "0"),
    signature: signed ? "ab".repeat(64) : null,
    signed,
    eventCount: 5 + idx,
    attestor: "inariwatch",
    verified: signed ? true : null,
    verifiedAt: signed ? new Date("2026-04-25T12:00:00Z") : null,
    createdAt: new Date(`2026-04-${10 + idx}T12:00:00Z`),
    alertId: ALERT_ID,
    alertTitle: `Alert ${idx}: TypeError caught`,
    alertSeverity: "warning",
    alertFingerprint: `fp-${idx}`,
    alertCreatedAt: new Date(`2026-04-${10 + idx}T11:00:00Z`),
    remediationSessionId: REMED_ID,
    remediationPrUrl: `https://github.com/owner/repo/pull/${100 + idx}`,
    remediationMergedSha: "deadbeef".repeat(5),
    remediationConfidence: 80 + idx,
    projectId: PROJECT_ID,
    projectName: "Demo Project",
    projectSlug: "demo-project",
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("buildAuditExport", () => {
  beforeEach(() => {
    dbSelectQueue = [];
  });

  it("emits manifest + summary + per-receipt JSONs with control mapping", async () => {
    // Queue: 1) resolveProjectIds, 2) loadReceipts, 3) loadOrgName (skipped — orgId null)
    dbSelectQueue.push([{ id: PROJECT_ID }]);
    dbSelectQueue.push([makeReceipt(1, true), makeReceipt(2, false)]);

    const { buildAuditExport } = await import("@/lib/services/audit-export");

    const bundle = await buildAuditExport({
      userId: "user-1",
      organizationId: null,
      standard: "soc2",
      startDate: new Date("2026-04-01T00:00:00Z"),
      endDate: new Date("2026-04-30T23:59:59Z"),
    });

    expect(bundle.receiptCount).toBe(2);
    expect(bundle.signedCount).toBe(1);
    expect(bundle.filename).toMatch(/^inariwatch-soc2-\d{4}-\d{2}-\d{2}\.zip$/);
    expect(bundle.bytes).toBe(bundle.zip.byteLength);

    const files = extractZip(bundle.zip);
    expect(files.has("manifest.json")).toBe(true);
    expect(files.has("summary.pdf")).toBe(true);

    // Receipt JSON files are present, one per receipt.
    const receiptPaths = [...files.keys()].filter((k) =>
      k.startsWith("receipts/"),
    );
    expect(receiptPaths.length).toBe(2);

    // Manifest carries the chosen standard + control list.
    const manifest = JSON.parse(utf8(files.get("manifest.json")!));
    expect(manifest.bundle_version).toBe(1);
    expect(manifest.standard.id).toBe("soc2");
    expect(manifest.standard.controls.length).toBeGreaterThan(0);
    expect(manifest.receipt_summary).toEqual({
      total: 2,
      signed: 1,
      unsigned: 1,
    });
    // Attestor public key is exposed for offline verification.
    expect(manifest.attestor.public_key).toBe("11".repeat(32));
    expect(manifest.attestor.key_id).toBe("0123456789abcdef");
    expect(manifest.verification.method).toBe("ed25519-receipt-chain");

    // Each per-receipt JSON carries the standard's control IDs.
    for (const path of receiptPaths) {
      const receipt = JSON.parse(utf8(files.get(path)!));
      expect(Array.isArray(receipt.controls)).toBe(true);
      expect(receipt.controls).toEqual(
        manifest.standard.controls.map((c: { id: string }) => c.id),
      );
      expect(typeof receipt.merkle_root).toBe("string");
      expect(receipt.verify_url).toBe(`/api/eap/verify/${receipt.receipt_id}`);
    }

    // Summary PDF starts with the standard %PDF- magic.
    const pdf = files.get("summary.pdf")!;
    expect(utf8(pdf.subarray(0, 8))).toBe("%PDF-1.4");
  });

  it("maps PCI/HIPAA/GDPR standards to disjoint control IDs", async () => {
    const { buildAuditExport } = await import("@/lib/services/audit-export");

    const seen = new Map<string, string[]>();
    for (const standard of ["pci", "hipaa", "gdpr"] as const) {
      dbSelectQueue.push([{ id: PROJECT_ID }]);
      dbSelectQueue.push([makeReceipt(1, true)]);
      const bundle = await buildAuditExport({
        userId: "user-1",
        organizationId: null,
        standard,
        startDate: new Date("2026-04-01T00:00:00Z"),
        endDate: new Date("2026-04-30T23:59:59Z"),
      });
      const manifest = JSON.parse(
        utf8(extractZip(bundle.zip).get("manifest.json")!),
      );
      seen.set(
        standard,
        manifest.standard.controls.map((c: { id: string }) => c.id),
      );
    }

    // Each standard must use its own control namespace.
    expect(seen.get("pci")![0]).toMatch(/^10\.|^11\./);
    expect(seen.get("hipaa")![0]).toMatch(/^164\./);
    expect(seen.get("gdpr")![0]).toMatch(/^Art\./);
  });

  it("returns an empty bundle when no projects exist for the user", async () => {
    dbSelectQueue.push([]); // no projects

    const { buildAuditExport } = await import("@/lib/services/audit-export");
    const bundle = await buildAuditExport({
      userId: "user-1",
      organizationId: null,
      standard: "soc2",
      startDate: new Date("2026-04-01T00:00:00Z"),
      endDate: new Date("2026-04-30T23:59:59Z"),
    });
    expect(bundle.receiptCount).toBe(0);
    expect(bundle.signedCount).toBe(0);

    const files = extractZip(bundle.zip);
    // Only manifest + summary, no receipts/.
    expect([...files.keys()].sort()).toEqual(["manifest.json", "summary.pdf"]);
  });

  it("rejects inverted date ranges", async () => {
    const { buildAuditExport } = await import("@/lib/services/audit-export");
    await expect(
      buildAuditExport({
        userId: "user-1",
        organizationId: null,
        standard: "soc2",
        startDate: new Date("2026-04-30T00:00:00Z"),
        endDate: new Date("2026-04-01T00:00:00Z"),
      }),
    ).rejects.toThrow(/startDate must be <= endDate/);
  });

  it("rejects ranges longer than 366 days", async () => {
    const { buildAuditExport } = await import("@/lib/services/audit-export");
    await expect(
      buildAuditExport({
        userId: "user-1",
        organizationId: null,
        standard: "soc2",
        startDate: new Date("2025-01-01T00:00:00Z"),
        endDate: new Date("2026-04-25T00:00:00Z"),
      }),
    ).rejects.toThrow(/cannot exceed 366 days/);
  });

  it("scales: 1k receipts produce a multi-page index PDF and one JSON each", async () => {
    const base = new Date("2026-04-15T00:00:00Z").getTime();
    const uniqued = Array.from({ length: 1000 }, (_, i) => {
      const r = makeReceipt(1, i % 2 === 0);
      return {
        ...r,
        receiptId: i.toString(16).padStart(64, "0"),
        merkleRoot: i.toString(16).padStart(64, "0"),
        // Spread receipts across 1000 minutes — all valid timestamps.
        createdAt: new Date(base + i * 60_000),
        alertCreatedAt: new Date(base + i * 60_000 - 5_000),
      };
    });

    dbSelectQueue.push([{ id: PROJECT_ID }]);
    dbSelectQueue.push(uniqued);

    const { buildAuditExport } = await import("@/lib/services/audit-export");
    const bundle = await buildAuditExport({
      userId: "user-1",
      organizationId: null,
      standard: "soc2",
      startDate: new Date("2026-04-01T00:00:00Z"),
      endDate: new Date("2026-04-30T23:59:59Z"),
    });

    expect(bundle.receiptCount).toBe(1000);
    expect(bundle.signedCount).toBe(500);

    const files = extractZip(bundle.zip);
    const receiptPaths = [...files.keys()].filter((k) =>
      k.startsWith("receipts/"),
    );
    expect(receiptPaths.length).toBe(1000);

    // Cover + ceil(1000/30) = 1 + 34 index pages.
    const pdf = utf8(files.get("summary.pdf")!);
    const pageCount = (pdf.match(/\/Type \/Page\b/g) ?? []).length;
    expect(pageCount).toBe(35);
  });
});
