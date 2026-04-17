/**
 * FullTrace manifest aggregator — pulls Substrate I/O events + AI events
 * for a session and shapes them for the player's Backend/AI panels.
 *
 * Why aggregate here (not in the route):
 *   - Pure functions are testable. The route handler is mostly auth + R2.
 *   - Future surfaces (sharing, exports, MCP tools) want the same shape
 *     without re-implementing the join + flatten.
 *   - Keeps the manifest GET handler under one screen.
 *
 * Time normalization: every emitted event has `ts` in ms relative to the
 * replay session's `startedAt`. Substrate timestamps come in nanoseconds
 * from the agent; alert + remediation timestamps come from Postgres
 * `timestamptz`. We never trust the input clock — we always compute the
 * delta from a known anchor (the player's t=0).
 */

import { db } from "@/lib/db";
import { substrateRecordings, alerts, remediationSessions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * A single Substrate I/O event ready for rendering. Mirrors the categories
 * already used by the Recording viewer (recordings/[id]/viewer.tsx) so the
 * UI vocabulary stays consistent across surfaces.
 */
export type BackendCategory =
  | "http"
  | "db"
  | "fs"
  | "dns"
  | "exception"
  | "process"
  | "time"
  | "random"
  | "marker";

export interface BackendEvent {
  /** Stable id — recording_id + seq within recording. */
  id: string;
  /** Session-relative milliseconds. */
  ts: number;
  category: BackendCategory;
  /** The raw Substrate kind.type — e.g. "HttpRequest", "DbQuery". */
  type: string;
  summary: string;
  /** Optional structured fields surfaced for richer rendering. */
  durationMs?: number;
  status?: number;
  errorMessage?: string;
  /** Recording id this event came from — for deep-linking back to /recordings/[id]. */
  recordingId: string;
}

/**
 * One step in the AI track. Spans the lifecycle from alert ingestion to
 * remediation merge/revert. The kind drives the icon + colour in the UI;
 * the title is the one-line label; the body (if present) is rendered in
 * an expandable detail row.
 */
export type AiEventKind =
  | "alert"
  | "diagnosis"
  | "remediation_started"
  | "remediation_step"
  | "remediation_completed"
  | "remediation_failed"
  | "fix_merged"
  | "fix_reverted";

export interface AiEvent {
  /** Stable id — used for React keys and seek anchoring. */
  id: string;
  ts: number;
  kind: AiEventKind;
  title: string;
  body?: string;
  /** Foreign keys for deep-links — when present, the panel renders a
   *  "View alert" / "View remediation" link instead of just text. */
  alertId?: string;
  remediationId?: string;
  /** Severity for alert events; status for remediation events. Used to
   *  pick a tone (red/amber/green) without re-parsing the title. */
  tone?: "critical" | "warning" | "info" | "success" | "danger";
}

// ── Substrate aggregation ──────────────────────────────────────────────────

const CATEGORY_MAP: Record<string, BackendCategory> = {
  HttpRequest: "http",
  HttpResponse: "http",
  DbQuery: "db",
  FileRead: "fs",
  FileWrite: "fs",
  DnsResolve: "dns",
  TimeNow: "time",
  TimeHrtime: "time",
  RandomFloat: "random",
  RandomBytes: "random",
  Exception: "exception",
  ProcessStart: "process",
  Marker: "marker",
};

/** One-line summary per Substrate event type. Mirrors recordings viewer. */
function summarize(kind: Record<string, unknown>): string {
  const t = String(kind.type ?? "");
  switch (t) {
    case "HttpRequest":
      return `${kind.method ?? "GET"} ${kind.url ?? ""}`;
    case "HttpResponse":
      return `${kind.status ?? "?"} (${kind.duration_ms ?? "?"}ms)`;
    case "DbQuery":
      return String(kind.query ?? "").slice(0, 100);
    case "FileRead":
      return `read ${kind.path ?? ""}`;
    case "FileWrite":
      return `write ${kind.path ?? ""}`;
    case "DnsResolve":
      return `resolve ${kind.hostname ?? ""}`;
    case "Exception": {
      const name = kind.name ?? "Error";
      const msg = String(kind.message ?? "").slice(0, 80);
      return `${name}: ${msg}`;
    }
    case "ProcessStart":
      return String(kind.command ?? "");
    case "TimeNow":
      return `${kind.value ?? "?"}ms`;
    case "Marker":
      return String(kind.label ?? "marker");
    default:
      return t;
  }
}

/**
 * Aggregate Substrate I/O events for a session. Walks every recording with
 * matching `session_id`, flattens their `events` jsonb, and converts
 * timestamp_ns to session-relative ms.
 *
 * For sessions with no Substrate recordings (Replay-only, server cron),
 * returns []. Never throws on malformed event payloads — we log and skip.
 */
export async function aggregateBackendEvents(
  sessionId: string,
  baseTimeMs: number,
): Promise<BackendEvent[]> {
  const recordings = await db
    .select({
      recordingId: substrateRecordings.recordingId,
      events: substrateRecordings.events,
      startedAt: substrateRecordings.startedAt,
    })
    .from(substrateRecordings)
    .where(eq(substrateRecordings.sessionId, sessionId));

  const out: BackendEvent[] = [];

  for (const rec of recordings) {
    const events = Array.isArray(rec.events) ? rec.events : [];
    const recBaseMs = rec.startedAt ? rec.startedAt.getTime() : baseTimeMs;
    // Inside a recording, the first event's timestamp_ns is the recording
    // origin. We compute deltas off it, then add (recordingStart - sessionStart)
    // to land on the session's time axis.
    const firstNs = (() => {
      for (const e of events) {
        const ns = (e as { timestamp_ns?: number }).timestamp_ns;
        if (typeof ns === "number" && Number.isFinite(ns)) return ns;
      }
      return 0;
    })();

    const recordingOffsetMs = recBaseMs - baseTimeMs;

    for (const raw of events) {
      const e = raw as { seq?: number; timestamp_ns?: number; kind?: Record<string, unknown> };
      if (!e.kind || typeof e.kind !== "object") continue;

      const ns = typeof e.timestamp_ns === "number" ? e.timestamp_ns : firstNs;
      const intraRecordingMs = (ns - firstNs) / 1_000_000;
      const ts = recordingOffsetMs + intraRecordingMs;

      const type = String(e.kind.type ?? "");
      const category = CATEGORY_MAP[type] ?? "marker";

      out.push({
        id: `${rec.recordingId}-${e.seq ?? out.length}`,
        ts,
        category,
        type,
        summary: summarize(e.kind),
        recordingId: rec.recordingId,
        ...(typeof e.kind.duration_ms === "number" ? { durationMs: e.kind.duration_ms } : {}),
        ...(typeof e.kind.status === "number" ? { status: e.kind.status } : {}),
        ...(typeof e.kind.message === "string" && type === "Exception"
          ? { errorMessage: String(e.kind.message) }
          : {}),
      });
    }
  }

  // Stable order: by session-relative ts ascending, then by stable id.
  out.sort((a, b) => (a.ts === b.ts ? a.id.localeCompare(b.id) : a.ts - b.ts));
  return out;
}

// ── AI events aggregation ──────────────────────────────────────────────────

const SEVERITY_TONE: Record<string, AiEvent["tone"]> = {
  critical: "critical",
  warning: "warning",
  info: "info",
};

/**
 * Aggregate AI lifecycle events for a session — alerts that fired,
 * AI diagnoses, and any remediations spawned from those alerts.
 *
 * Output is sorted by session-relative timestamp. Each remediation
 * contributes 2 + N events (start, N steps, end) so the Player's AI
 * panel can render a coherent narrative without re-querying.
 */
export async function aggregateAiEvents(
  sessionId: string,
  baseTimeMs: number,
): Promise<AiEvent[]> {
  const sessionAlerts = await db
    .select({
      id: alerts.id,
      title: alerts.title,
      severity: alerts.severity,
      aiReasoning: alerts.aiReasoning,
      isResolved: alerts.isResolved,
      createdAt: alerts.createdAt,
      resolvedAt: alerts.resolvedAt,
    })
    .from(alerts)
    .where(eq(alerts.sessionId, sessionId));

  if (sessionAlerts.length === 0) return [];

  const alertIds = sessionAlerts.map((a) => a.id);
  // Fetch every remediation for these alerts in one round-trip; some alerts
  // may have multiple attempts.
  const remediations = alertIds.length === 0
    ? []
    : await db
        .select({
          id: remediationSessions.id,
          alertId: remediationSessions.alertId,
          status: remediationSessions.status,
          steps: remediationSessions.steps,
          prUrl: remediationSessions.prUrl,
          mergedCommitSha: remediationSessions.mergedCommitSha,
          revertPrUrl: remediationSessions.revertPrUrl,
          monitoringStatus: remediationSessions.monitoringStatus,
          createdAt: remediationSessions.createdAt,
          updatedAt: remediationSessions.updatedAt,
        })
        .from(remediationSessions)
        // drizzle-orm doesn't expose `inArray` consumers ergonomically here
        // for a multi-id select; we fall back to a small N+1 since N is
        // typically 1-3. If this becomes a hot path we can switch to inArray.
        .where(eq(remediationSessions.alertId, alertIds[0]));
  // Backfill the rest sequentially. Tiny and bounded — 99% of sessions
  // have 1 alert, 99.9% have <5.
  if (alertIds.length > 1) {
    for (const id of alertIds.slice(1)) {
      const more = await db
        .select({
          id: remediationSessions.id,
          alertId: remediationSessions.alertId,
          status: remediationSessions.status,
          steps: remediationSessions.steps,
          prUrl: remediationSessions.prUrl,
          mergedCommitSha: remediationSessions.mergedCommitSha,
          revertPrUrl: remediationSessions.revertPrUrl,
          monitoringStatus: remediationSessions.monitoringStatus,
          createdAt: remediationSessions.createdAt,
          updatedAt: remediationSessions.updatedAt,
        })
        .from(remediationSessions)
        .where(eq(remediationSessions.alertId, id));
      remediations.push(...more);
    }
  }

  const out: AiEvent[] = [];

  for (const a of sessionAlerts) {
    const ts = a.createdAt.getTime() - baseTimeMs;
    out.push({
      id: `alert-${a.id}`,
      ts,
      kind: "alert",
      title: a.title,
      tone: SEVERITY_TONE[a.severity] ?? "info",
      alertId: a.id,
    });

    if (a.aiReasoning) {
      out.push({
        // Diagnosis lands moments after the alert; 1ms offset keeps the
        // sort stable without inventing a fake server timestamp.
        id: `diag-${a.id}`,
        ts: ts + 1,
        kind: "diagnosis",
        title: "AI diagnosis ready",
        body: a.aiReasoning.slice(0, 500),
        alertId: a.id,
        tone: "info",
      });
    }
  }

  for (const r of remediations) {
    const startTs = r.createdAt.getTime() - baseTimeMs;
    out.push({
      id: `rem-start-${r.id}`,
      ts: startTs,
      kind: "remediation_started",
      title: "Remediation started",
      tone: "info",
      remediationId: r.id,
      alertId: r.alertId,
    });

    const steps = Array.isArray(r.steps) ? (r.steps as Array<Record<string, unknown>>) : [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const stepTs = (() => {
        const raw = s.timestamp;
        if (typeof raw === "string") {
          const parsed = Date.parse(raw);
          if (Number.isFinite(parsed)) return parsed - baseTimeMs;
        }
        // Fall back to start + index ms — keeps ordering deterministic when
        // steps lack timestamps (older remediation rows).
        return startTs + i;
      })();
      out.push({
        id: `rem-step-${r.id}-${i}`,
        ts: stepTs,
        kind: "remediation_step",
        title: String(s.message ?? s.type ?? "step"),
        tone: s.status === "failed" ? "danger" : s.status === "completed" ? "success" : "info",
        remediationId: r.id,
        alertId: r.alertId,
      });
    }

    const endTs = r.updatedAt.getTime() - baseTimeMs;
    if (r.status === "completed") {
      out.push({
        id: `rem-done-${r.id}`,
        ts: endTs,
        kind: r.mergedCommitSha ? "fix_merged" : "remediation_completed",
        title: r.mergedCommitSha ? "Fix merged" : "Remediation completed",
        body: r.prUrl ?? undefined,
        tone: "success",
        remediationId: r.id,
        alertId: r.alertId,
      });
    } else if (r.status === "failed" || r.status === "cancelled") {
      out.push({
        id: `rem-fail-${r.id}`,
        ts: endTs,
        kind: "remediation_failed",
        title: r.status === "cancelled" ? "Remediation cancelled" : "Remediation failed",
        tone: "danger",
        remediationId: r.id,
        alertId: r.alertId,
      });
    }
    if (r.monitoringStatus === "reverted" && r.revertPrUrl) {
      out.push({
        id: `rem-revert-${r.id}`,
        ts: endTs + 1,
        kind: "fix_reverted",
        title: "Fix auto-reverted (regression)",
        body: r.revertPrUrl,
        tone: "danger",
        remediationId: r.id,
        alertId: r.alertId,
      });
    }
  }

  out.sort((a, b) => (a.ts === b.ts ? a.id.localeCompare(b.id) : a.ts - b.ts));
  return out;
}
