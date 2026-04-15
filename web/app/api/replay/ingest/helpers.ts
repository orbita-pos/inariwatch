/**
 * Pure helpers for the replay ingest endpoint — extracted so they can be
 * unit-tested without spinning up Next.js, the DB, or R2.
 */

import { REPLAY_LIMITS } from "@/lib/storage/replay-storage";

export interface IngestBody {
  sessionId: string;
  projectId: string;
  blockIndex: number;
  startMs: number;
  endMs: number;
  events: unknown[];
  metadata?: {
    startedAt?: number;
    endedAt?: number;
    browser?: string;
    os?: string;
    viewport?: { width: number; height: number; dpr?: number };
    isFinal?: boolean;
  };
}

export const SELECTOR_LIMIT = 50;
export const URL_LIMIT = 50;
export const ERROR_FP_LIMIT = 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * SDK always emits `s_<uuid>` or `s_<32hex>`. Reject anything else so
 * attackers can't flood the index with junk sessionIds like path-traversal
 * strings, SQL-looking blobs, or collisions with real ids.
 */
const SESSION_ID_RE = /^s_[A-Za-z0-9_-]{6,128}$/;

/**
 * Returns null if valid, or an error message string if the body is malformed.
 * Does NOT touch I/O — safe to call with untrusted input from the network.
 */
export function validateIngestBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return "Invalid body";
  const b = body as Partial<IngestBody>;
  if (typeof b.sessionId !== "string" || !SESSION_ID_RE.test(b.sessionId)) {
    return "Invalid sessionId (must match s_<8-128 alphanum/_/->)";
  }
  if (typeof b.projectId !== "string" || !UUID_RE.test(b.projectId)) {
    return "Invalid projectId (must be UUID)";
  }
  if (typeof b.blockIndex !== "number" || b.blockIndex < 0 || b.blockIndex > 100_000 || !Number.isInteger(b.blockIndex)) {
    return "Invalid blockIndex";
  }
  if (typeof b.startMs !== "number" || b.startMs < 0) return "Invalid startMs";
  if (typeof b.endMs !== "number" || b.endMs < b.startMs) return "Invalid endMs";
  if (!Array.isArray(b.events)) return "events must be an array";
  if (b.events.length === 0) return "events cannot be empty";
  if (b.events.length > REPLAY_LIMITS.MAX_BLOCK_EVENTS) {
    return `events exceeds max ${REPLAY_LIMITS.MAX_BLOCK_EVENTS}`;
  }
  return null;
}

// rrweb event types: 3 = IncrementalSnapshot, source 2 = MouseInteraction, type 2 = Click
export function extractClickSelectors(events: unknown[]): string[] {
  const out: string[] = [];
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as { type?: number; data?: { source?: number; type?: number; selector?: string } };
    if (e.type === 3 && e.data?.source === 2 && e.data.type === 2 && typeof e.data.selector === "string") {
      const sel = e.data.selector.slice(0, 200);
      if (!out.includes(sel)) out.push(sel);
    }
  }
  return out;
}

// rrweb meta event (type 4) carries href on full snapshots
export function extractUrls(events: unknown[]): string[] {
  const out: string[] = [];
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as { type?: number; data?: { href?: string } };
    if (e.type === 4 && typeof e.data?.href === "string") {
      const url = e.data.href.slice(0, 500);
      if (!out.includes(url)) out.push(url);
    }
  }
  return out;
}

// Errors are tagged with _kind="error" when the SDK injects them into the stream
export function extractErrorFingerprints(events: unknown[]): string[] {
  const out: string[] = [];
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as { _kind?: string; fingerprint?: string };
    if (e._kind === "error" && typeof e.fingerprint === "string") {
      const fp = e.fingerprint.slice(0, 128);
      if (!out.includes(fp)) out.push(fp);
    }
  }
  return out;
}
