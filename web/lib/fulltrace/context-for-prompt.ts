/**
 * FullTrace context formatter for AI prompts.
 *
 * Given an alert id, returns a compact prompt-friendly text block that
 * summarises the browser session it came from: backend I/O, AI lifecycle
 * events, all timestamped relative to the session start. Returns null when
 * the alert has no correlated session (legacy data, server cron, etc.) so
 * callers can drop the section entirely from the prompt.
 *
 * Why this exists separately from manifest-aggregator:
 *   - The aggregator produces typed events optimized for the player UI
 *     (ids for hover correlation, structured shape per event)
 *   - This file produces a one-line-per-event TEXT block optimized for
 *     LLM input (small token count, chronological, human-readable)
 *
 * Both consume the same source data; the format is what differs.
 *
 * Output cap: 30 events combined. The AI rarely needs more — the most
 * recent events before the alert fired carry the causal signal. If your
 * prompt needs more, render an extra summary card in the UI; don't push
 * 200 events at the model.
 */

import { db } from "@/lib/db";
import { alerts, replaySessions, substrateRecordings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  aggregateBackendEvents,
  aggregateAiEvents,
  type BackendEvent,
  type AiEvent,
} from "./manifest-aggregator";

const MAX_EVENTS_IN_PROMPT = 30;

export async function getFullTraceContextForAlert(alertId: string): Promise<string | null> {
  const [alert] = await db
    .select({
      sessionId: alerts.sessionId,
      title: alerts.title,
    })
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alert?.sessionId) return null;

  // Resolve a base timestamp so all events normalize onto a session-relative
  // axis. Prefer the replay_session row (the canonical session start). Fall
  // back to the earliest substrate_recording if no replay exists — server
  // cron triggered alerts can land in this branch.
  const baseTimeMs = await resolveBaseTimeMs(alert.sessionId);
  if (baseTimeMs === null) return null;

  const [backend, ai] = await Promise.all([
    aggregateBackendEvents(alert.sessionId, baseTimeMs),
    aggregateAiEvents(alert.sessionId, baseTimeMs),
  ]);

  if (backend.length === 0 && ai.length === 0) return null;

  return formatPrompt(alert.sessionId, backend, ai);
}

async function resolveBaseTimeMs(sessionId: string): Promise<number | null> {
  const [replay] = await db
    .select({ startedAt: replaySessions.startedAt })
    .from(replaySessions)
    .where(eq(replaySessions.sessionId, sessionId))
    .limit(1);
  if (replay) return replay.startedAt.getTime();

  const [rec] = await db
    .select({ startedAt: substrateRecordings.startedAt })
    .from(substrateRecordings)
    .where(eq(substrateRecordings.sessionId, sessionId))
    .limit(1);
  if (rec?.startedAt) return rec.startedAt.getTime();

  return null;
}

// ── Formatting ─────────────────────────────────────────────────────────────

/** Render `+m:ss.mmm` so the AI gets human-friendly relative time without
 *  parsing dates. Negative ts is clamped to 0 — happens occasionally when
 *  a substrate recording's first event landed slightly before the
 *  replay_session row's startedAt. */
function relativeTime(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalSec = clamped / 1000;
  const minutes = Math.floor(totalSec / 60);
  const seconds = Math.floor(totalSec % 60);
  const millis = Math.floor(clamped % 1000);
  return `+${minutes}:${seconds.toString().padStart(2, "0")}.${millis.toString().padStart(3, "0")}`;
}

function summarizeBackend(e: BackendEvent): string {
  const parts: string[] = [];
  if (typeof e.status === "number") parts.push(String(e.status));
  if (typeof e.durationMs === "number") parts.push(`${Math.round(e.durationMs)}ms`);
  const suffix = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `${e.category.padEnd(9)} ${e.summary}${suffix}`;
}

function summarizeAi(e: AiEvent): string {
  const tone = e.tone ? ` [${e.tone}]` : "";
  return `${e.kind.padEnd(20)} ${e.title}${tone}`;
}

function formatPrompt(sessionId: string, backend: BackendEvent[], ai: AiEvent[]): string {
  // Merge + sort + truncate. The truncation favours RECENT events (the ones
  // closest to the alert) because that's where the causal signal lives.
  type Row = { ts: number; kind: "backend" | "ai"; line: string };
  const rows: Row[] = [
    ...backend.map((e) => ({ ts: e.ts, kind: "backend" as const, line: summarizeBackend(e) })),
    ...ai.map((e) => ({ ts: e.ts, kind: "ai" as const, line: summarizeAi(e) })),
  ];
  rows.sort((a, b) => a.ts - b.ts);

  const truncated = rows.length > MAX_EVENTS_IN_PROMPT;
  const slice = truncated ? rows.slice(-MAX_EVENTS_IN_PROMPT) : rows;
  const truncationNote = truncated
    ? `(showing last ${MAX_EVENTS_IN_PROMPT} of ${rows.length} events — earliest events trimmed)\n`
    : "";

  const lines = slice.map((r) => `  ${relativeTime(r.ts)}  ${r.kind === "backend" ? "B" : "A"}  ${r.line}`);

  return [
    `FullTrace causal chain (session ${sessionId.slice(0, 16)}):`,
    truncationNote,
    `Timeline (B=backend I/O, A=AI lifecycle event):`,
    ...lines,
  ]
    .filter(Boolean)
    .join("\n");
}
