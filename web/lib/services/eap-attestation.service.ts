/**
 * EAP attestation submission — VAR Q3 Phase 2.
 *
 * After a remediation completes successfully we POST the associated
 * substrate recording's event stream to the EAP server, which Merkle-
 * roots + Ed25519-signs + stores a receipt and returns its ID. We
 * persist that ID on `remediation_sessions.eap_receipt_id` so the
 * alert detail page can link to the public audit URL at
 * `/attestation/<receipt_id>`.
 *
 * This service is the ONLY place in InariWatch that talks to the EAP
 * `/receipts/from-events` endpoint. Callers treat the result as fire-
 * and-forget — a failed submission should NEVER fail a remediation.
 * The remediation's value is in the fix it merged; the EAP receipt is
 * a downstream audit artifact.
 *
 * Required env:
 *   EAP_SERVER_URL       — base URL of the EAP server
 *   EAP_API_KEY          — Bearer token required by the write endpoint
 *                          (when EAP server is deployed with auth)
 *
 * When either env is unset, `submitReceiptForRemediation` returns
 * `{ ok: false, skipped: "eap-not-configured" }` without making a
 * network call — matches the Phase 1 `/api/attestation/:id` contract
 * that returns 503 with a hint in the same state.
 */

import { db } from "@/lib/db";
import {
  alerts,
  remediationSessions,
  substrateRecordings,
} from "@/lib/db/schema";
import { and, desc, eq, isNotNull } from "drizzle-orm";

const ATTESTOR_NAME = "inariwatch";

/** EAP /receipts/from-events input shape — mirrors `FromEventsInput` in
 *  the Rust server. Keep these in sync on any Rust API change. */
interface EapSubmitInput {
  recording_id: string;
  command: string[];
  runtime: string;
  started_at: string;
  ended_at: string | null;
  cwd?: string;
  events: unknown[];
  attestor?: string;
}

interface EapSubmitResponse {
  status: "created" | "exists";
  receipt_id: string;
  event_count: number;
  signed: boolean;
}

export type SubmitOutcome =
  | { ok: true; receiptId: string; status: "created" | "exists"; signed: boolean }
  | { ok: false; skipped: "eap-not-configured" | "no-recording-found" | "already-attested" }
  | { ok: false; failed: string };

/**
 * Find the substrate_recording tied to a remediation's alert and POST
 * its events to the EAP server. Persists the returned receipt_id on
 * `remediation_sessions.eap_receipt_id`.
 *
 * Idempotent: subsequent calls for a remediation that already has an
 * `eap_receipt_id` short-circuit with `skipped: "already-attested"`
 * without hitting EAP.
 */
export async function submitReceiptForRemediation(
  remediationSessionId: string,
): Promise<SubmitOutcome> {
  const eapServerUrl = process.env.EAP_SERVER_URL;
  const eapApiKey = process.env.EAP_API_KEY;
  if (!eapServerUrl) {
    return { ok: false, skipped: "eap-not-configured" };
  }

  // 1. Load the remediation + alert linkage + existing receipt (if any).
  const [row] = await db
    .select({
      id: remediationSessions.id,
      alertId: remediationSessions.alertId,
      command: remediationSessions.repo,
      branch: remediationSessions.branch,
      mergedCommitSha: remediationSessions.mergedCommitSha,
      existingReceiptId: remediationSessions.eapReceiptId,
      alertSessionId: alerts.sessionId,
    })
    .from(remediationSessions)
    .innerJoin(alerts, eq(alerts.id, remediationSessions.alertId))
    .where(eq(remediationSessions.id, remediationSessionId))
    .limit(1);

  if (!row) {
    return { ok: false, failed: "remediation not found" };
  }
  if (row.existingReceiptId) {
    return { ok: false, skipped: "already-attested" };
  }

  // 2. Find the most recent substrate recording for this alert (or for
  // the session that spawned it). substrate_recordings has both
  // alert_id and session_id; we match on either to cover alert-triggered
  // and session-triggered recording paths.
  const [rec] = await db
    .select({
      recordingId: substrateRecordings.recordingId,
      command: substrateRecordings.command,
      runtime: substrateRecordings.runtime,
      startedAt: substrateRecordings.startedAt,
      endedAt: substrateRecordings.endedAt,
      events: substrateRecordings.events,
    })
    .from(substrateRecordings)
    .where(
      and(
        row.alertSessionId
          ? eq(substrateRecordings.sessionId, row.alertSessionId)
          : eq(substrateRecordings.alertId, row.alertId),
        isNotNull(substrateRecordings.events),
      ),
    )
    .orderBy(desc(substrateRecordings.createdAt))
    .limit(1);

  if (!rec || !rec.events || !rec.startedAt) {
    return { ok: false, skipped: "no-recording-found" };
  }

  const events = Array.isArray(rec.events) ? rec.events : [];
  if (events.length === 0) {
    return { ok: false, skipped: "no-recording-found" };
  }

  // 3. Build + submit.
  const payload: EapSubmitInput = {
    recording_id: rec.recordingId,
    command: parseCommand(rec.command),
    runtime: rec.runtime ?? "node",
    started_at: rec.startedAt.toISOString(),
    ended_at: rec.endedAt ? rec.endedAt.toISOString() : null,
    cwd: "",
    events,
    attestor: ATTESTOR_NAME,
  };

  let res: Response;
  try {
    res = await fetch(`${eapServerUrl.replace(/\/$/, "")}/receipts/from-events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(eapApiKey ? { authorization: `Bearer ${eapApiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[eap-attestation] network error:", msg);
    return { ok: false, failed: `network: ${msg.slice(0, 100)}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[eap-attestation] upstream error:", res.status, body.slice(0, 200));
    return { ok: false, failed: `upstream ${res.status}` };
  }

  const body = (await res.json()) as EapSubmitResponse;
  if (!body.receipt_id || body.receipt_id.length !== 64) {
    return { ok: false, failed: "invalid receipt_id from upstream" };
  }

  // 4. Persist the receipt_id on the remediation so the UI can link to
  // the public audit page.
  await db
    .update(remediationSessions)
    .set({ eapReceiptId: body.receipt_id, updatedAt: new Date() })
    .where(eq(remediationSessions.id, remediationSessionId));

  return {
    ok: true,
    receiptId: body.receipt_id,
    status: body.status,
    signed: body.signed,
  };
}

/**
 * `substrateRecordings.command` is stored as a joined string (see
 * app/api/recordings/upload/route.ts:216) — split it back into a Vec
 * for the EAP payload. Falls back to ["unknown"] when the column is
 * null/empty so the EAP server's "command must be non-empty" validator
 * doesn't trip.
 */
function parseCommand(cmd: string | null): string[] {
  if (!cmd) return ["unknown"];
  const parts = cmd.trim().split(/\s+/).filter(Boolean);
  return parts.length > 0 ? parts : ["unknown"];
}
