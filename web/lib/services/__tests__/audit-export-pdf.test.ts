/**
 * Smoke tests for the hand-rolled PDF generator. We don't render the PDF
 * — we only verify the byte-level structure (header, %%EOF marker, xref
 * table consistency) since most PDF readers tolerate cosmetic issues but
 * choke on a missing xref or wrong /Size.
 */

import { describe, it, expect } from "vitest";
import { buildSummaryPdf } from "@/lib/services/audit-export-pdf";

function asString(buf: Uint8Array): string {
  return Buffer.from(buf).toString("latin1");
}

const FAKE_MANIFEST = {
  generated_at: "2026-04-25T12:00:00.000Z",
  standard: { id: "soc2" as const, label: "SOC 2", full: "SOC 2 Type II" },
  workspace: { organization_id: null, organization_name: null },
  date_range: { start: "2026-03-26T00:00:00.000Z", end: "2026-04-25T23:59:59.000Z" },
  receipt_summary: { total: 2, signed: 1, unsigned: 1 },
  attestor: {
    key_id: "deadbeefdeadbeef",
    public_key: "00".repeat(32),
    available: true,
    name: "inariwatch",
  },
};

const FAKE_RECEIPTS = [
  {
    receiptId: "a".repeat(64),
    alertTitle: "TypeError: cannot read property 'foo' of undefined",
    createdAt: new Date("2026-04-20T09:30:00Z"),
    signed: true,
  },
  {
    receiptId: "b".repeat(64),
    alertTitle: "PostgresError: deadlock detected",
    createdAt: new Date("2026-04-22T15:45:00Z"),
    signed: false,
  },
];

describe("buildSummaryPdf", () => {
  it("produces a PDF starting with %PDF- and ending with %%EOF", () => {
    const pdf = buildSummaryPdf({
      standard: FAKE_MANIFEST.standard,
      manifest: FAKE_MANIFEST,
      receipts: FAKE_RECEIPTS,
    });
    const s = asString(pdf);
    expect(s.startsWith("%PDF-1.4")).toBe(true);
    expect(s.endsWith("%%EOF\n")).toBe(true);
  });

  it("declares one xref entry per object and aligns offsets", () => {
    const pdf = buildSummaryPdf({
      standard: FAKE_MANIFEST.standard,
      manifest: FAKE_MANIFEST,
      receipts: FAKE_RECEIPTS,
    });
    const s = asString(pdf);

    // /Size N must equal (object count + 1 for the free object 0).
    const sizeMatch = s.match(/\/Size (\d+)/);
    expect(sizeMatch).toBeTruthy();
    const declared = Number(sizeMatch![1]);

    // xref header: "xref\n0 N\n"
    const xrefHeader = s.match(/xref\n0 (\d+)\n/);
    expect(xrefHeader).toBeTruthy();
    expect(Number(xrefHeader![1])).toBe(declared);

    // startxref offset must point at the literal `xref` keyword.
    const startxrefMatch = s.match(/startxref\n(\d+)\n%%EOF/);
    expect(startxrefMatch).toBeTruthy();
    const startxref = Number(startxrefMatch![1]);
    expect(s.slice(startxref, startxref + 4)).toBe("xref");
  });

  it("includes the standard label and attestor key id on the cover page", () => {
    const pdf = buildSummaryPdf({
      standard: FAKE_MANIFEST.standard,
      manifest: FAKE_MANIFEST,
      receipts: FAKE_RECEIPTS,
    });
    const s = asString(pdf);
    expect(s).toContain("SOC 2 Type II");
    expect(s).toContain("deadbeefdeadbeef");
  });

  it("renders one cover + one index page for a small receipt set", () => {
    const pdf = buildSummaryPdf({
      standard: FAKE_MANIFEST.standard,
      manifest: FAKE_MANIFEST,
      receipts: FAKE_RECEIPTS,
    });
    const s = asString(pdf);
    const pageMatches = s.match(/\/Type \/Page\b/g) ?? [];
    expect(pageMatches.length).toBe(2);
  });

  it("emits an additional index page per 30 receipts", () => {
    const many = Array.from({ length: 65 }, (_, i) => ({
      receiptId: i.toString(16).padStart(64, "0"),
      alertTitle: `alert ${i}`,
      createdAt: new Date("2026-04-20T09:30:00Z"),
      signed: i % 2 === 0,
    }));
    const pdf = buildSummaryPdf({
      standard: FAKE_MANIFEST.standard,
      manifest: { ...FAKE_MANIFEST, receipt_summary: { total: 65, signed: 33, unsigned: 32 } },
      receipts: many,
    });
    const s = asString(pdf);
    const pageMatches = s.match(/\/Type \/Page\b/g) ?? [];
    // 1 cover + ceil(65/30) = 1 + 3 = 4
    expect(pageMatches.length).toBe(4);
  });
});
