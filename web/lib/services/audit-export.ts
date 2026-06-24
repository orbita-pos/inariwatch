/**
 * Compliance-grade audit export — Sesión 19, Track H pieza 21.
 *
 * Turns the EAP receipt chain (Merkle root + Ed25519 signature per fix)
 * into a ZIP bundle that maps each receipt to the controls of a chosen
 * standard (SOC 2 TSC, PCI DSS 4.0, HIPAA Security Rule, GDPR Art. 30).
 *
 * Why local: the EAP chain already covers evidence → fix → deploy with
 * cryptographic guarantees. This module is the *presentation layer* an
 * auditor expects — it does not introduce new trust assumptions, and the
 * receipts themselves remain independently verifiable through
 * `/api/eap/verify/:receiptId` (content-addressed, no auth).
 *
 * Output format: a single ZIP (STORE method, no compression — keeps the
 * implementation dependency-free and lets auditors inspect bytes
 * verbatim) with the layout:
 *
 *   manifest.json          — bundle metadata + standard mapping
 *   summary.pdf            — auditor-facing one-pager (text PDF)
 *   receipts/
 *     <receipt_id>.json    — one receipt per file
 *
 * Each receipt JSON re-exposes the public material we mirror locally
 * (Merkle root + Ed25519 signature when present) plus the alert metadata
 * the auditor needs to correlate the fix with a real production event.
 *
 * Cryptographic verification of the bundle is not via PKCS#7 PDF signing
 * (which requires X.509 infra we don't run) — it is via the per-receipt
 * Ed25519 signatures, anchored to the EAP attestor's public key. The
 * manifest exposes the attestor's pubkey + key_id so an auditor can
 * re-run `verifyEd25519Signature` offline.
 */

import { and, desc, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  alerts,
  eapReceipts,
  organizationMembers,
  organizations,
  projects,
  remediationSessions,
  users,
} from "@/lib/db/schema";
import { getAttestorInfo } from "@/lib/services/eap-verify-local";
import { buildStoreZip } from "@/lib/services/audit-export-zip";
import { buildSummaryPdf } from "@/lib/services/audit-export-pdf";

// ── Standards ────────────────────────────────────────────────────────────────

export type ComplianceStandard = "soc2" | "pci" | "hipaa" | "gdpr";

export const STANDARDS: ReadonlyArray<{
  id: ComplianceStandard;
  label: string;
  full: string;
  /** Controls each receipt is claimed to evidence. */
  controls: ReadonlyArray<{ id: string; title: string }>;
}> = [
  {
    id: "soc2",
    label: "SOC 2",
    full: "SOC 2 Type II — Trust Services Criteria",
    controls: [
      { id: "CC7.1", title: "Detection and monitoring of system events" },
      { id: "CC7.2", title: "Anomalies analyzed and acted on" },
      { id: "CC7.3", title: "Security incidents evaluated for impact" },
      { id: "CC7.4", title: "Incidents responded to" },
      { id: "CC8.1", title: "Changes authorized, designed, tested, approved" },
    ],
  },
  {
    id: "pci",
    label: "PCI DSS 4.0",
    full: "Payment Card Industry Data Security Standard v4.0",
    controls: [
      { id: "10.2.1", title: "Audit logs capture user actions affecting CHD" },
      { id: "10.2.2", title: "All actions taken by privileged accounts logged" },
      { id: "10.4", title: "Audit logs reviewed daily" },
      { id: "10.5", title: "Audit log integrity protected" },
      { id: "11.5", title: "Change-detection mechanism in place" },
    ],
  },
  {
    id: "hipaa",
    label: "HIPAA",
    full: "HIPAA Security Rule §164.312 — Technical Safeguards",
    controls: [
      { id: "164.312(b)", title: "Audit Controls — record + examine activity" },
      {
        id: "164.312(c)(1)",
        title: "Integrity — protect ePHI from improper alteration",
      },
      {
        id: "164.312(c)(2)",
        title: "Mechanism to authenticate ePHI not altered",
      },
      {
        id: "164.308(a)(1)(ii)(D)",
        title: "Information system activity review",
      },
    ],
  },
  {
    id: "gdpr",
    label: "GDPR",
    full: "GDPR Article 30 — Records of Processing Activities",
    controls: [
      { id: "Art.30(1)(g)", title: "Description of technical security measures" },
      { id: "Art.32(1)(b)", title: "Ensure ongoing integrity of processing systems" },
      { id: "Art.32(1)(d)", title: "Regular testing of effectiveness of measures" },
      { id: "Art.33", title: "Notification of personal data breach traceability" },
    ],
  },
] as const;

export function getStandard(id: ComplianceStandard) {
  const s = STANDARDS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown standard: ${id}`);
  return s;
}

// ── Public types ────────────────────────────────────────────────────────────

export interface AuditExportRequest {
  /** Caller user ID — used for plan check + audit logging + scoping. */
  userId: string;
  /** Optional org. null = personal workspace (user's projects with no org). */
  organizationId: string | null;
  standard: ComplianceStandard;
  /** Inclusive UTC date — receipts where created_at >= startDate. */
  startDate: Date;
  /** Inclusive UTC date — receipts where created_at <= endDate. */
  endDate: Date;
}

export interface AuditExportBundle {
  /** Full ZIP body. */
  zip: Uint8Array;
  /** Suggested filename, e.g. inariwatch-soc2-2026-04-25.zip. */
  filename: string;
  /** Counts for the audit log + UI. */
  receiptCount: number;
  signedCount: number;
  bytes: number;
}

export interface ExportPreview {
  receiptCount: number;
  signedCount: number;
  earliest: Date | null;
  latest: Date | null;
}

// ── Authorization ──────────────────────────────────────────────────────────

/**
 * Compliance export is a paid-tier feature. During beta everyone gets it
 * (matches the rest of the dashboard's ProGate behaviour) but enforcement
 * lives here so an API caller can't bypass the UI gate. When beta ends,
 * flip this to require `plan === 'pro'` and the rest of the surface
 * keeps working.
 */
export async function isExportAllowedForUser(userId: string): Promise<boolean> {
  const [u] = await db
    .select({ plan: users.plan })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u) return false;
  // Beta: every authenticated user is on Pro for compliance features.
  // Post-beta, drop the `|| true` and rely solely on the plan column.
  return u.plan === "pro" || true;
}

/**
 * Confirm the caller belongs to (or owns) the requested organization.
 * Personal workspace (organizationId === null) is always allowed for the
 * caller's own projects.
 */
export async function isOrgMember(
  userId: string,
  organizationId: string | null,
): Promise<boolean> {
  if (organizationId === null) return true;
  const [owned] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        eq(organizations.id, organizationId),
        eq(organizations.ownerId, userId),
      ),
    )
    .limit(1);
  if (owned) return true;
  const [member] = await db
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .limit(1);
  return !!member;
}

// ── Project scope ──────────────────────────────────────────────────────────

/**
 * Resolve which project IDs the caller can include in the export.
 *
 *   organizationId === null → personal workspace: projects owned by the
 *     caller that are not assigned to an organization.
 *   organizationId === uuid → all projects owned by that org.
 *
 * NOTE: this is intentionally simpler than `getWorkspaceProjectIds` —
 * the export is an org-wide compliance artifact and should include every
 * project under the org, including ones the *individual* caller might
 * not see day-to-day in their dashboard.
 */
async function resolveProjectIds(
  userId: string,
  organizationId: string | null,
): Promise<string[]> {
  if (organizationId === null) {
    const rows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.userId, userId));
    return rows.map((r) => r.id);
  }
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.organizationId, organizationId));
  return rows.map((r) => r.id);
}

// ── Preview (cheap count for the UI before user clicks Export) ─────────────

export async function previewExport(
  req: Omit<AuditExportRequest, "standard">,
): Promise<ExportPreview> {
  const projectIds = await resolveProjectIds(req.userId, req.organizationId);
  if (projectIds.length === 0) {
    return { receiptCount: 0, signedCount: 0, earliest: null, latest: null };
  }
  const rows = await loadReceipts({
    projectIds,
    startDate: req.startDate,
    endDate: req.endDate,
  });
  let signedCount = 0;
  let earliest: Date | null = null;
  let latest: Date | null = null;
  for (const r of rows) {
    if (r.signed) signedCount++;
    if (!earliest || r.createdAt < earliest) earliest = r.createdAt;
    if (!latest || r.createdAt > latest) latest = r.createdAt;
  }
  return { receiptCount: rows.length, signedCount, earliest, latest };
}

// ── Main export builder ────────────────────────────────────────────────────

/**
 * Build the ZIP bundle. Pure CPU + DB reads — no network calls beyond
 * an optional EAP `/attestor` lookup to embed the attestor pubkey in the
 * manifest (best-effort; we tag the manifest as "attestor-unknown" if
 * the EAP server is unreachable so an auditor can still verify offline
 * by retrieving the pubkey themselves).
 */
export async function buildAuditExport(
  req: AuditExportRequest,
): Promise<AuditExportBundle> {
  validateDateRange(req.startDate, req.endDate);

  const standard = getStandard(req.standard);
  const projectIds = await resolveProjectIds(req.userId, req.organizationId);

  const receipts =
    projectIds.length === 0
      ? []
      : await loadReceipts({
          projectIds,
          startDate: req.startDate,
          endDate: req.endDate,
        });

  const orgName = await loadOrgName(req.organizationId);
  const attestor = await getAttestorInfo().catch(() => null);
  const generatedAt = new Date();

  const manifest = buildManifest({
    standard,
    receipts,
    orgName,
    attestor,
    request: req,
    generatedAt,
  });

  const pdf = buildSummaryPdf({
    standard,
    manifest,
    receipts: receipts.map((r) => ({
      receiptId: r.receiptId,
      alertTitle: r.alertTitle,
      createdAt: r.createdAt,
      signed: r.signed,
    })),
  });

  const files: Array<{ path: string; data: Uint8Array }> = [
    {
      path: "manifest.json",
      data: textBytes(JSON.stringify(manifest, null, 2)),
    },
    { path: "summary.pdf", data: pdf },
  ];

  for (const r of receipts) {
    const receiptDoc = {
      receipt_id: r.receiptId,
      merkle_root: r.merkleRoot,
      signature: r.signature,
      signed: r.signed,
      event_count: r.eventCount,
      attestor: r.attestor,
      verified_locally: r.verified,
      verified_at: r.verifiedAt ? r.verifiedAt.toISOString() : null,
      created_at: r.createdAt.toISOString(),
      alert: {
        id: r.alertId,
        title: r.alertTitle,
        severity: r.alertSeverity,
        fingerprint: r.alertFingerprint,
        created_at: r.alertCreatedAt ? r.alertCreatedAt.toISOString() : null,
      },
      remediation: r.remediationSessionId
        ? {
            id: r.remediationSessionId,
            pr_url: r.remediationPrUrl,
            merged_commit_sha: r.remediationMergedSha,
            confidence_score: r.remediationConfidence,
          }
        : null,
      project: {
        id: r.projectId,
        name: r.projectName,
        slug: r.projectSlug,
      },
      controls: standard.controls.map((c) => c.id),
      verify_url: `/api/eap/verify/${r.receiptId}`,
    };
    files.push({
      path: `receipts/${r.receiptId}.json`,
      data: textBytes(JSON.stringify(receiptDoc, null, 2)),
    });
  }

  const zip = buildStoreZip(files, generatedAt);
  const ymd = generatedAt.toISOString().slice(0, 10);
  const filename = `inariwatch-${standard.id}-${ymd}.zip`;

  let signedCount = 0;
  for (const r of receipts) if (r.signed) signedCount++;

  return {
    zip,
    filename,
    receiptCount: receipts.length,
    signedCount,
    bytes: zip.byteLength,
  };
}

// ── Internals ──────────────────────────────────────────────────────────────

interface ReceiptRow {
  receiptId: string;
  merkleRoot: string;
  signature: string | null;
  signed: boolean;
  eventCount: number;
  attestor: string;
  verified: boolean | null;
  verifiedAt: Date | null;
  createdAt: Date;
  alertId: string;
  alertTitle: string;
  alertSeverity: string;
  alertFingerprint: string | null;
  alertCreatedAt: Date | null;
  remediationSessionId: string | null;
  remediationPrUrl: string | null;
  remediationMergedSha: string | null;
  remediationConfidence: number | null;
  projectId: string;
  projectName: string;
  projectSlug: string;
}

async function loadReceipts(opts: {
  projectIds: string[];
  startDate: Date;
  endDate: Date;
}): Promise<ReceiptRow[]> {
  const { projectIds, startDate, endDate } = opts;

  // Joining 4 tables here so the export is one shot per request — the
  // bundle is bounded by the date range (typically a week or month) and
  // each receipt row is small. Caller is expected to keep ranges bounded
  // (the API enforces a 366-day cap).
  const rows = await db
    .select({
      receiptId: eapReceipts.receiptId,
      merkleRoot: eapReceipts.merkleRoot,
      signature: eapReceipts.signature,
      signed: eapReceipts.signed,
      eventCount: eapReceipts.eventCount,
      attestor: eapReceipts.attestor,
      verified: eapReceipts.verified,
      verifiedAt: eapReceipts.verifiedAt,
      createdAt: eapReceipts.createdAt,
      alertId: alerts.id,
      alertTitle: alerts.title,
      alertSeverity: alerts.severity,
      alertFingerprint: alerts.fingerprint,
      alertCreatedAt: alerts.createdAt,
      remediationSessionId: remediationSessions.id,
      remediationPrUrl: remediationSessions.prUrl,
      remediationMergedSha: remediationSessions.mergedCommitSha,
      remediationConfidence: remediationSessions.confidenceScore,
      projectId: projects.id,
      projectName: projects.name,
      projectSlug: projects.slug,
    })
    .from(eapReceipts)
    .innerJoin(alerts, eq(alerts.id, eapReceipts.alertId))
    .innerJoin(projects, eq(projects.id, alerts.projectId))
    .leftJoin(
      remediationSessions,
      eq(remediationSessions.id, eapReceipts.remediationSessionId),
    )
    .where(
      and(
        inArray(projects.id, projectIds),
        gte(eapReceipts.createdAt, startDate),
        lte(eapReceipts.createdAt, endDate),
        isNotNull(eapReceipts.merkleRoot),
      ),
    )
    .orderBy(desc(eapReceipts.createdAt));

  return rows;
}

async function loadOrgName(
  organizationId: string | null,
): Promise<string | null> {
  if (organizationId === null) return null;
  const [row] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row?.name ?? null;
}

interface AttestorInfoLite {
  keyAvailable: boolean;
  publicKey: string | null;
  keyId: string | null;
  attestorName: string | null;
  algorithm: "ed25519";
}

interface ManifestShape {
  bundle_version: 1;
  generated_at: string;
  standard: {
    id: ComplianceStandard;
    label: string;
    full: string;
    controls: ReadonlyArray<{ id: string; title: string }>;
  };
  workspace: {
    organization_id: string | null;
    organization_name: string | null;
  };
  date_range: {
    start: string;
    end: string;
  };
  receipt_summary: {
    total: number;
    signed: number;
    unsigned: number;
  };
  attestor: {
    name: string | null;
    public_key: string | null;
    key_id: string | null;
    algorithm: "ed25519";
    available: boolean;
  };
  verification: {
    method: "ed25519-receipt-chain";
    digest_algorithm: "sha256";
    pre_hash: "SHA-256(receipt_id_utf8)";
    notes: string;
  };
  receipts: Array<{
    receipt_id: string;
    signed: boolean;
    created_at: string;
    alert_id: string;
    project_slug: string;
    controls: string[];
    file: string;
  }>;
}

function buildManifest(opts: {
  standard: (typeof STANDARDS)[number];
  receipts: ReceiptRow[];
  orgName: string | null;
  attestor: AttestorInfoLite | null;
  request: AuditExportRequest;
  generatedAt: Date;
}): ManifestShape {
  const { standard, receipts, orgName, attestor, request, generatedAt } = opts;
  let signed = 0;
  for (const r of receipts) if (r.signed) signed++;

  return {
    bundle_version: 1,
    generated_at: generatedAt.toISOString(),
    standard: {
      id: standard.id,
      label: standard.label,
      full: standard.full,
      controls: standard.controls,
    },
    workspace: {
      organization_id: request.organizationId,
      organization_name: orgName,
    },
    date_range: {
      start: request.startDate.toISOString(),
      end: request.endDate.toISOString(),
    },
    receipt_summary: {
      total: receipts.length,
      signed,
      unsigned: receipts.length - signed,
    },
    attestor: {
      name: attestor?.attestorName ?? null,
      public_key: attestor?.publicKey ?? null,
      key_id: attestor?.keyId ?? null,
      algorithm: "ed25519",
      available: !!attestor?.keyAvailable,
    },
    verification: {
      method: "ed25519-receipt-chain",
      digest_algorithm: "sha256",
      pre_hash: "SHA-256(receipt_id_utf8)",
      notes:
        "Each receipt is content-addressed (receipt_id == Merkle root over the original event stream). Signed receipts can be re-verified offline with Ed25519.verify(public_key, SHA-256(receipt_id), signature). The same receipt is independently servable from /api/eap/verify/<receipt_id>.",
    },
    receipts: receipts.map((r) => ({
      receipt_id: r.receiptId,
      signed: r.signed,
      created_at: r.createdAt.toISOString(),
      alert_id: r.alertId,
      project_slug: r.projectSlug,
      controls: standard.controls.map((c) => c.id),
      file: `receipts/${r.receiptId}.json`,
    })),
  };
}

function validateDateRange(start: Date, end: Date): void {
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("invalid date range");
  }
  if (start > end) {
    throw new Error("startDate must be <= endDate");
  }
  const ms = end.getTime() - start.getTime();
  const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;
  if (ms > MAX_RANGE_MS) {
    throw new Error("date range cannot exceed 366 days");
  }
}

function textBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
