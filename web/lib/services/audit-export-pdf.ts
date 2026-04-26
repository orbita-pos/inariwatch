/**
 * Minimal text-only PDF generator for the compliance audit export.
 *
 * Hand-rolls a PDF 1.4 document with a single embedded Helvetica font
 * (the 14 PDF base fonts that every reader ships) and ASCII text content.
 * No deps — `pdfkit` is ~600 KB and we only need a one-pager summary
 * that wraps a few headings + a 80-row table.
 *
 * Pages:
 *   1. Cover — workspace, date range, standard, attestor key_id, totals.
 *   2..N. Receipt index — 30 rows per page, format:
 *         <created_at>  <signed?>  <receipt_id_short>  <alert_title_trunc>
 *
 * We sidestep "real" PDF signing (PKCS#7 + X.509) — the cryptographic
 * trust anchor is the per-receipt Ed25519 signature carried in the JSON
 * files alongside this PDF. The PDF is auditor-readable; the JSON is
 * the verification surface.
 */

import type { ComplianceStandard } from "@/lib/services/audit-export";

const PAGE_W = 612;   // 8.5 in × 72 dpi (US Letter, the default auditors expect)
const PAGE_H = 792;
const MARGIN = 54;    // 0.75 in

const FONT_REGULAR = "F1"; // Helvetica
const FONT_BOLD = "F2";    // Helvetica-Bold
const FONT_MONO = "F3";    // Courier (monospace for receipt ids)

const SIZE_TITLE = 18;
const SIZE_H2 = 12;
const SIZE_BODY = 10;
const SIZE_TABLE = 9;

const ROWS_PER_PAGE = 30;

interface ReceiptForPdf {
  receiptId: string;
  alertTitle: string;
  createdAt: Date;
  signed: boolean;
}

interface ManifestForPdf {
  generated_at: string;
  standard: { id: ComplianceStandard; label: string; full: string };
  workspace: { organization_id: string | null; organization_name: string | null };
  date_range: { start: string; end: string };
  receipt_summary: { total: number; signed: number; unsigned: number };
  attestor: {
    key_id: string | null;
    public_key: string | null;
    available: boolean;
    name: string | null;
  };
}

export function buildSummaryPdf(opts: {
  standard: { id: ComplianceStandard; label: string; full: string };
  manifest: ManifestForPdf;
  receipts: ReadonlyArray<ReceiptForPdf>;
}): Uint8Array {
  const builder = new PdfBuilder();

  drawCoverPage(builder, opts);

  // Index pages.
  for (let i = 0; i < opts.receipts.length; i += ROWS_PER_PAGE) {
    const slice = opts.receipts.slice(i, i + ROWS_PER_PAGE);
    drawIndexPage(builder, {
      pageNumber: 1 + Math.floor(i / ROWS_PER_PAGE),
      totalPages: Math.ceil(opts.receipts.length / ROWS_PER_PAGE),
      receipts: slice,
    });
  }

  return builder.finish();
}

function drawCoverPage(
  b: PdfBuilder,
  opts: {
    standard: { id: ComplianceStandard; label: string; full: string };
    manifest: ManifestForPdf;
    receipts: ReadonlyArray<ReceiptForPdf>;
  },
): void {
  const { standard, manifest, receipts } = opts;
  b.addPage();
  let y = PAGE_H - MARGIN;

  b.text({
    text: "InariWatch — Compliance Audit Export",
    x: MARGIN,
    y,
    font: FONT_BOLD,
    size: SIZE_TITLE,
  });
  y -= SIZE_TITLE + 14;

  b.text({
    text: standard.full,
    x: MARGIN,
    y,
    font: FONT_REGULAR,
    size: SIZE_H2,
  });
  y -= SIZE_H2 + 18;

  const lines: Array<[string, string]> = [
    ["Generated", manifest.generated_at],
    [
      "Workspace",
      manifest.workspace.organization_name ??
        (manifest.workspace.organization_id
          ? manifest.workspace.organization_id
          : "Personal"),
    ],
    [
      "Date range",
      `${manifest.date_range.start.slice(0, 10)}  →  ${manifest.date_range.end.slice(0, 10)}`,
    ],
    ["Standard", `${standard.label}  (${standard.id})`],
    [
      "Receipts",
      `${manifest.receipt_summary.total} total · ${manifest.receipt_summary.signed} signed · ${manifest.receipt_summary.unsigned} unsigned`,
    ],
    [
      "Attestor",
      manifest.attestor.available
        ? `${manifest.attestor.name ?? "inariwatch"}  (key_id ${manifest.attestor.key_id ?? "?"})`
        : "unavailable at export time — verify offline via /api/eap/verify/<id>",
    ],
    [
      "Verification",
      "Ed25519 over SHA-256(receipt_id_utf8); pubkey embedded in manifest.json",
    ],
  ];

  for (const [k, v] of lines) {
    b.text({ text: k, x: MARGIN, y, font: FONT_BOLD, size: SIZE_BODY });
    b.text({ text: v, x: MARGIN + 90, y, font: FONT_REGULAR, size: SIZE_BODY });
    y -= SIZE_BODY + 6;
  }

  y -= 18;
  b.text({
    text: "What this bundle proves",
    x: MARGIN,
    y,
    font: FONT_BOLD,
    size: SIZE_H2,
  });
  y -= SIZE_H2 + 8;

  const explainParas = [
    "Each line in receipts/ is a tamper-evident receipt of one autonomous fix that was deployed to production. The receipt_id is the SHA-256 Merkle root over the original I/O event stream — content-addressed, so any modification breaks the link.",
    "When 'signed' is true the receipt also carries an Ed25519 signature over the receipt_id, anchored to the attestor pubkey above. Verify offline with Ed25519.verify(pubkey, SHA-256(receipt_id), signature) — no network access required.",
    "Each receipt is independently re-servable from /api/eap/verify/<receipt_id>. The endpoint returns the same JSON; the URL itself is a capability (the ID IS the Merkle root) so no auth is needed.",
  ];

  for (const p of explainParas) {
    const wrapped = wrapText(p, 80);
    for (const line of wrapped) {
      b.text({ text: line, x: MARGIN, y, font: FONT_REGULAR, size: SIZE_BODY });
      y -= SIZE_BODY + 2;
    }
    y -= 6;
  }

  if (receipts.length === 0) {
    y -= 10;
    b.text({
      text: "No receipts in this date range.",
      x: MARGIN,
      y,
      font: FONT_BOLD,
      size: SIZE_BODY,
    });
  }
}

function drawIndexPage(
  b: PdfBuilder,
  opts: {
    pageNumber: number;
    totalPages: number;
    receipts: ReadonlyArray<ReceiptForPdf>;
  },
): void {
  b.addPage();
  let y = PAGE_H - MARGIN;

  b.text({
    text: `Receipt index — page ${opts.pageNumber} of ${opts.totalPages}`,
    x: MARGIN,
    y,
    font: FONT_BOLD,
    size: SIZE_H2,
  });
  y -= SIZE_H2 + 12;

  b.text({ text: "Date (UTC)", x: MARGIN, y, font: FONT_BOLD, size: SIZE_TABLE });
  b.text({ text: "Sig", x: MARGIN + 110, y, font: FONT_BOLD, size: SIZE_TABLE });
  b.text({
    text: "Receipt (first 16 hex)",
    x: MARGIN + 145,
    y,
    font: FONT_BOLD,
    size: SIZE_TABLE,
  });
  b.text({
    text: "Alert",
    x: MARGIN + 280,
    y,
    font: FONT_BOLD,
    size: SIZE_TABLE,
  });
  y -= SIZE_TABLE + 6;

  for (const r of opts.receipts) {
    const created = r.createdAt.toISOString().replace("T", " ").slice(0, 19);
    const id = r.receiptId.slice(0, 16);
    const title = truncate(r.alertTitle, 38);
    b.text({ text: created, x: MARGIN, y, font: FONT_MONO, size: SIZE_TABLE });
    b.text({
      text: r.signed ? "yes" : "no",
      x: MARGIN + 110,
      y,
      font: FONT_MONO,
      size: SIZE_TABLE,
    });
    b.text({ text: id, x: MARGIN + 145, y, font: FONT_MONO, size: SIZE_TABLE });
    b.text({
      text: title,
      x: MARGIN + 280,
      y,
      font: FONT_REGULAR,
      size: SIZE_TABLE,
    });
    y -= SIZE_TABLE + 4;
  }
}

// ── PDF builder ─────────────────────────────────────────────────────────────

interface PdfObject {
  /** 1-based ID; assigned in declaration order. */
  id: number;
  body: string;
}

interface PageState {
  contentObjId: number;
  pageObjId: number;
  /** Accumulated content stream (BT…ET blocks). */
  content: string;
}

class PdfBuilder {
  private objects: PdfObject[] = [];
  private pages: PageState[] = [];
  /** Monotonic id counter — first allocated id is 1. */
  private nextId = 1;
  /** Declared up front so every page can reference the same font ids. */
  private readonly fontRegularId: number;
  private readonly fontBoldId: number;
  private readonly fontMonoId: number;
  /** Pages tree id — declared before pages so they can carry /Parent. */
  private readonly pagesObjId: number;

  constructor() {
    this.fontRegularId = this.allocId();
    this.fontBoldId = this.allocId();
    this.fontMonoId = this.allocId();
    this.pagesObjId = this.allocId();
    this.add(this.fontRegularId, fontDict("Helvetica"));
    this.add(this.fontBoldId, fontDict("Helvetica-Bold"));
    this.add(this.fontMonoId, fontDict("Courier"));
    // /Pages added at finish() once we know all kids.
  }

  addPage(): void {
    const contentObjId = this.allocId();
    const pageObjId = this.allocId();
    this.pages.push({ contentObjId, pageObjId, content: "" });
  }

  text(opts: {
    text: string;
    x: number;
    y: number;
    font: string;
    size: number;
  }): void {
    if (this.pages.length === 0) {
      throw new Error("text() called before addPage()");
    }
    const page = this.pages[this.pages.length - 1]!;
    const escaped = escapePdfString(opts.text);
    page.content += `BT /${opts.font} ${opts.size} Tf ${opts.x} ${opts.y} Td (${escaped}) Tj ET\n`;
  }

  finish(): Uint8Array {
    // Emit page content streams + page objects.
    for (const p of this.pages) {
      const stream = p.content;
      const streamBytes = Buffer.byteLength(stream, "latin1");
      this.add(
        p.contentObjId,
        `<< /Length ${streamBytes} >>\nstream\n${stream}endstream`,
      );

      const pageBody = [
        "<<",
        "/Type /Page",
        `/Parent ${this.pagesObjId} 0 R`,
        `/MediaBox [0 0 ${PAGE_W} ${PAGE_H}]`,
        `/Contents ${p.contentObjId} 0 R`,
        "/Resources <<",
        "  /Font <<",
        `    /${FONT_REGULAR} ${this.fontRegularId} 0 R`,
        `    /${FONT_BOLD} ${this.fontBoldId} 0 R`,
        `    /${FONT_MONO} ${this.fontMonoId} 0 R`,
        "  >>",
        ">>",
        ">>",
      ].join("\n");
      this.add(p.pageObjId, pageBody);
    }

    // /Pages tree.
    const kids = this.pages.map((p) => `${p.pageObjId} 0 R`).join(" ");
    this.add(
      this.pagesObjId,
      `<< /Type /Pages /Count ${this.pages.length} /Kids [${kids}] >>`,
    );

    // /Catalog (root).
    const catalogId = this.allocId();
    this.add(
      catalogId,
      `<< /Type /Catalog /Pages ${this.pagesObjId} 0 R >>`,
    );

    // Serialize: header + objects + xref + trailer.
    const header = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
    let body = header;
    const offsets: number[] = [];

    for (const obj of this.objects) {
      offsets.push(byteLen(body));
      body += `${obj.id} 0 obj\n${obj.body}\nendobj\n`;
    }

    const xrefStart = byteLen(body);
    body += `xref\n0 ${this.objects.length + 1}\n`;
    body += "0000000000 65535 f \n";
    for (const off of offsets) {
      body += `${off.toString().padStart(10, "0")} 00000 n \n`;
    }
    body += `trailer\n<< /Size ${this.objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

    return new Uint8Array(Buffer.from(body, "latin1"));
  }

  private add(id: number, body: string): void {
    this.objects.push({ id, body });
    // Sort so indirect-reference offsets line up with declared IDs in xref.
    this.objects.sort((a, b) => a.id - b.id);
  }

  private allocId(): number {
    return this.nextId++;
  }
}

function fontDict(baseFont: string): string {
  // Helvetica / Helvetica-Bold / Courier are the PDF 1.4 base fonts every
  // reader is required to ship — no font program embedded.
  return [
    "<<",
    "/Type /Font",
    "/Subtype /Type1",
    `/BaseFont /${baseFont}`,
    "/Encoding /WinAnsiEncoding",
    ">>",
  ].join("\n");
}

function escapePdfString(s: string): string {
  // Per PDF 32000-1 §7.3.4.2 — escape (, ), and \ in literal strings.
  // Restrict to printable ASCII so WinAnsi encoding stays safe.
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/[^\x20-\x7e]/g, "?");
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    if (!line) {
      line = w;
    } else if ((line + " " + w).length <= width) {
      line = line + " " + w;
    } else {
      out.push(line);
      line = w;
    }
  }
  if (line) out.push(line);
  return out;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, "latin1");
}
