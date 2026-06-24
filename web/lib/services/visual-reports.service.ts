/**
 * Visual Reports service — user-initiated "report visual bug" submissions.
 *
 * Distinct from the auto-captured exceptions that flow through
 * /api/webhooks/capture. Each row pairs 1:1 with an alerts row marked
 * source='user_report' and carries the rich capture bundle (DOM,
 * React state, console + network, source-map build_id, perf, user
 * events) that the AI diagnosis pipeline consumes.
 *
 * Used by:
 *   - POST /api/capture/user-report/[projectId] (ingest)
 *   - lib/services/visual-diagnosis.service.ts   (Phase 3 — pipeline)
 *   - GET  /api/desktop/visual-reports/[id]      (Inari Live)
 *   - GET  /api/desktop/visual-reports/route     (Inari Live list)
 *
 * Dedup: (projectId, bundleHash) — accidental double-submit within
 * createAlertIfNew's 24h fingerprint window returns the existing row.
 */

import crypto from "crypto";
import { db, alerts, visualReports } from "@/lib/db";
import { eq, desc, and } from "drizzle-orm";
import { createAlertIfNew } from "@/lib/webhooks/shared";
import type { VisualReport, NewVisualReport } from "@/lib/db";

// ── Types ────────────────────────────────────────────────────────────────────

export type CreateVisualReportInput = {
  projectId:     string;
  userId:        string | null;
  /** data: URI in V0 (base64 embedded). Object-storage URL in V0.5+. */
  screenshotUrl: string;
  /** Capture bundle JSON (DOM, fiber state, console, network, etc.). */
  bundle:        Record<string, unknown>;
  captureMs?:    number;
  payloadSize?:  number;
  redactionStats?: Record<string, number> | null;
  /** User-typed description from the widget — becomes the alert title. */
  description?:  string;
  sessionId?:    string | null;
};

export type CreateVisualReportResult = {
  reportId:   string;
  alertId:    string;
  bundleHash: string;
  /** True when an existing alert+report pair was returned (dedup hit). */
  deduped:    boolean;
};

export type VisualReportStatus =
  | "pending"
  | "triaging"
  | "diagnosing"
  | "critiquing"
  | "completed"
  | "rejected"
  | "need_info"
  | "failed";

export type UpdateReportStatusFields = {
  error?:         string;
  triageResult?:  unknown;
  diagnosis?:     unknown;
  critique?:      unknown;
  confidence?:    number;
  modelTriage?:   string;
  modelDiagnose?: string;
  modelCritique?: string;
  costCents?:     number;
  durationMs?:    number;
};

// ── Constants ────────────────────────────────────────────────────────────────

/** Used as the `fingerprint` on the spawned alert so accidental double-
 *  submits collapse via createAlertIfNew's 24h dedup window. */
const FINGERPRINT_PREFIX = "visual:";

/** Severity for user-initiated reports. They're not autonomous error
 *  signals — keep them at warning so a noisy widget doesn't drown out
 *  real critical alerts in dashboards. */
const VISUAL_REPORT_SEVERITY = "warning" as const;

// ── Mutations ────────────────────────────────────────────────────────────────

/**
 * Insert an alert + visual_report row. Idempotent on (projectId, bundleHash):
 * a duplicate submit within the dedup window returns the existing pair.
 * Returns null only when the project has an active maintenance window AND
 * no prior visual_report row exists for this bundle.
 */
export async function createVisualReport(
  input: CreateVisualReportInput,
): Promise<CreateVisualReportResult | null> {
  const bundleHash = sha256Hex(JSON.stringify(input.bundle));

  const description = (input.description ?? "").trim();
  const title = description
    ? `Visual report: ${truncate(description, 80)}`
    : "Visual report (no description)";

  const body = description || "(user submitted screenshot, no description)";

  // `createAlertIfNew` dedups on (projectId, fingerprint) within 24h.
  // Using bundleHash as fingerprint collapses identical resubmissions
  // while still letting the same user report a NEW visual bug with a
  // different bundle (different DOM/state/timestamp).
  const alert = await createAlertIfNew(
    {
      severity:           VISUAL_REPORT_SEVERITY,
      title,
      body,
      sourceIntegrations: ["user_report"],
      alertType:          "error",
      fingerprint:        FINGERPRINT_PREFIX + bundleHash.slice(0, 32),
      isRead:             false,
      isResolved:         false,
      sessionId:          input.sessionId ?? null,
    },
    input.projectId,
  );

  if (!alert) {
    // Either dedup hit OR maintenance window suppressed the alert. Look
    // up an existing visual_report row for this bundle — if one exists,
    // return it (dedup case). Otherwise null (maintenance case).
    const existing = await findExistingByHash(input.projectId, bundleHash);
    if (existing) {
      return {
        reportId:   existing.id,
        alertId:    existing.alertId,
        bundleHash,
        deduped:    true,
      };
    }
    return null;
  }

  // Stamp the user-typed description into the bundle so the AI diagnosis
  // pipeline has it inline alongside the captured context (single source).
  const bundleWithDesc: Record<string, unknown> = {
    ...input.bundle,
    userDescription: description,
  };

  const [report] = await db
    .insert(visualReports)
    .values({
      alertId:        alert.id,
      projectId:      input.projectId,
      userId:         input.userId,
      screenshotUrl:  input.screenshotUrl,
      bundleJson:     bundleWithDesc,
      bundleHash,
      captureMs:      input.captureMs ?? null,
      payloadSize:    input.payloadSize ?? null,
      redactionStats: input.redactionStats ?? null,
      status:         "pending",
    } satisfies NewVisualReport)
    .returning({ id: visualReports.id });

  return {
    reportId:   report.id,
    alertId:    alert.id,
    bundleHash,
    deduped:    false,
  };
}

/**
 * Update pipeline state. Used by the diagnosis orchestrator after each
 * phase (triage → diagnose → critique). Status is required; the rest
 * are sparse — only provided fields are written. Sets updated_at via
 * the table trigger (no manual write needed).
 */
export async function updateReportStatus(
  id: string,
  status: VisualReportStatus,
  fields: UpdateReportStatusFields = {},
): Promise<void> {
  const updates: Record<string, unknown> = { status };
  if (fields.error         !== undefined) updates.error          = fields.error;
  if (fields.triageResult  !== undefined) updates.triageResult   = fields.triageResult;
  if (fields.diagnosis     !== undefined) updates.diagnosis      = fields.diagnosis;
  if (fields.critique      !== undefined) updates.critique       = fields.critique;
  if (fields.confidence    !== undefined) updates.confidence     = fields.confidence;
  if (fields.modelTriage   !== undefined) updates.modelTriage    = fields.modelTriage;
  if (fields.modelDiagnose !== undefined) updates.modelDiagnose  = fields.modelDiagnose;
  if (fields.modelCritique !== undefined) updates.modelCritique  = fields.modelCritique;
  if (fields.costCents     !== undefined) updates.costCents      = fields.costCents;
  if (fields.durationMs    !== undefined) updates.durationMs     = fields.durationMs;
  await db.update(visualReports).set(updates).where(eq(visualReports.id, id));
}

// ── Queries ──────────────────────────────────────────────────────────────────

export async function getVisualReport(id: string): Promise<VisualReport | null> {
  const [row] = await db
    .select()
    .from(visualReports)
    .where(eq(visualReports.id, id))
    .limit(1);
  return row ?? null;
}

export async function getVisualReportByAlert(alertId: string): Promise<VisualReport | null> {
  const [row] = await db
    .select()
    .from(visualReports)
    .where(eq(visualReports.alertId, alertId))
    .limit(1);
  return row ?? null;
}

export async function listVisualReports(
  projectId: string,
  opts: { limit?: number; status?: VisualReportStatus } = {},
): Promise<VisualReport[]> {
  const { limit = 50, status } = opts;
  const conditions = [eq(visualReports.projectId, projectId)];
  if (status) conditions.push(eq(visualReports.status, status));
  return db
    .select()
    .from(visualReports)
    .where(and(...conditions))
    .orderBy(desc(visualReports.createdAt))
    .limit(Math.min(Math.max(limit, 1), 500));
}

// ── Internals ────────────────────────────────────────────────────────────────

async function findExistingByHash(
  projectId: string,
  bundleHash: string,
): Promise<VisualReport | null> {
  const [row] = await db
    .select()
    .from(visualReports)
    .where(
      and(
        eq(visualReports.projectId, projectId),
        eq(visualReports.bundleHash, bundleHash),
      ),
    )
    .orderBy(desc(visualReports.createdAt))
    .limit(1);
  return row ?? null;
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// Re-export the alerts table reference so future callers that need to
// JOIN with visual_reports don't have to import it from the top of the
// dependency graph.
export { alerts };
