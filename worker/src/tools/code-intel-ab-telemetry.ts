/**
 * Code Intelligence v2 — Phase 3.2 A/B telemetry writer.
 *
 * Records one row per `runAgentJob` to `code_intel_remediation_ab`. Called
 * from container-agent.ts in the finally block so both the success path
 * and the throw path get a row written.
 *
 * The writer is fire-and-forget at the call site (a thrown Neon error
 * MUST NOT abort a remediation), so we wrap the insert in a try/catch and
 * swallow on failure. The cutover script will see a smaller-than-actual
 * sample population if Neon hiccups, which is preferable to a broken
 * remediation pipeline.
 */

import { db, codeIntelRemediationAb, remediationSessions } from "../db.js";
import { eq } from "drizzle-orm";

import type { AgentEngine } from "./code-intel-ab.js";

const FAILURE_REASON_MAX_LEN = 500;

export interface AbTelemetryRow {
  sessionId: string;
  /** Falls back to a lookup against `remediation_sessions.alert_id` when null. */
  alertId: string | null;
  engine: AgentEngine;
  workspacePct: number | null;
  turnCount: number;
  success: boolean;
  costUsd: number | null;
  durationMs: number;
  startedAt: Date;
  finishedAt: Date;
  failureReason: string | null;
}

export async function writeAbTelemetry(row: AbTelemetryRow): Promise<void> {
  try {
    const alertId = row.alertId ?? (await lookupAlertId(row.sessionId));
    if (!alertId) {
      // Without an alert_id we can't satisfy the NOT NULL FK. Skip the
      // row rather than fail the remediation. The caller's audit can
      // detect missing rows by joining on remediation_session_id.
      return;
    }
    await db.insert(codeIntelRemediationAb).values({
      alertId,
      remediationSessionId: row.sessionId,
      engine: row.engine,
      workspacePct: row.workspacePct,
      turnCount: row.turnCount,
      success: row.success,
      costUsd: row.costUsd === null ? null : row.costUsd.toString(),
      durationMs: row.durationMs,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      failureReason: row.failureReason ? row.failureReason.slice(0, FAILURE_REASON_MAX_LEN) : null,
    });
  } catch {
    // Telemetry must never break a remediation. Any DB failure is silently
    // dropped — the cutover dashboard already tolerates a smaller-than-
    // theoretical sample set.
  }
}

async function lookupAlertId(sessionId: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ alertId: remediationSessions.alertId })
      .from(remediationSessions)
      .where(eq(remediationSessions.id, sessionId))
      .limit(1);
    return row?.alertId ?? null;
  } catch {
    return null;
  }
}
