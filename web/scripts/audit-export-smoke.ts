/**
 * Manual smoke check for the compliance audit export bundle. No DB —
 * directly exercises the builders + writes the artifacts to /tmp so we
 * can inspect them by hand (e.g. drag the .zip into Finder, open the
 * .pdf in Preview, run `unzip -l` on the .zip).
 *
 * Run with: npx tsx scripts/audit-export-smoke.ts
 */

import { writeFileSync } from "node:fs";
import { buildStoreZip } from "@/lib/services/audit-export-zip";
import { buildSummaryPdf } from "@/lib/services/audit-export-pdf";
import { STANDARDS } from "@/lib/services/audit-export";

const std = STANDARDS[0]!;
const receipts = Array.from({ length: 1000 }, (_, i) => ({
  receiptId: i.toString(16).padStart(64, "0"),
  alertTitle: `TypeError #${i}`,
  createdAt: new Date(Date.UTC(2026, 3, 15, 0, i % 60, 0)),
  signed: i % 2 === 0,
}));

const manifest = {
  generated_at: new Date().toISOString(),
  standard: { id: std.id, label: std.label, full: std.full },
  workspace: { organization_id: null, organization_name: null },
  date_range: {
    start: "2026-04-01T00:00:00.000Z",
    end: "2026-04-30T23:59:59.000Z",
  },
  receipt_summary: { total: 1000, signed: 500, unsigned: 500 },
  attestor: {
    key_id: "aabbccddeeff0011",
    public_key: "11".repeat(32),
    available: true,
    name: "inariwatch",
  },
};

const pdf = buildSummaryPdf({ standard: std, manifest, receipts });
const files: Array<{ path: string; data: Uint8Array }> = [
  {
    path: "manifest.json",
    data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  },
  { path: "summary.pdf", data: pdf },
];
for (const r of receipts.slice(0, 10)) {
  files.push({
    path: `receipts/${r.receiptId}.json`,
    data: new TextEncoder().encode(
      JSON.stringify(
        {
          receipt_id: r.receiptId,
          merkle_root: r.receiptId,
          signed: r.signed,
          attestor: "inariwatch",
        },
        null,
        2,
      ),
    ),
  });
}

const zip = buildStoreZip(files, new Date());
writeFileSync("audit-demo.zip", Buffer.from(zip));
writeFileSync("audit-demo.pdf", Buffer.from(pdf));

console.log("zip bytes:", zip.byteLength);
console.log("pdf bytes:", pdf.byteLength);
console.log(
  "pdf head:",
  Buffer.from(pdf).subarray(0, 12).toString("latin1"),
);
console.log(
  "pdf tail:",
  Buffer.from(pdf).subarray(-12).toString("latin1"),
);
