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
    /** Phase F — set from window.__INARIWATCH_USER__ in the SDK. Both
     *  fields are individually optional; either, both, or neither may
     *  arrive. The ingest validator caps lengths and strips control chars. */
    user?: { id?: string; email?: string };
  };
}

/** Cap on each end-user identifier field to keep storage / log lines bounded. */
export const END_USER_FIELD_LIMIT = 200;

/**
 * Sanitize a user-id or email string from the SDK before it touches the DB.
 * Strips control characters (which would render badly in dashboard UI and
 * could be used to inject ANSI escapes into logs), trims, caps length.
 * Returns null for empty / non-string input so callers can null-check once.
 */
export function sanitizeEndUserField(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Drop ASCII control chars (\x00-\x1F + \x7F) so log lines stay clean.
  const stripped = raw.replace(/[\x00-\x1F\x7F]/g, "").trim();
  if (stripped.length === 0) return null;
  return stripped.slice(0, END_USER_FIELD_LIMIT);
}

export const SELECTOR_LIMIT = 50;
export const URL_LIMIT = 50;
export const ERROR_FP_LIMIT = 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * SDK always emits `s_<uuid>` (32 hex) or `s_<base64url-encoded random>`.
 * Reject anything else so attackers can't flood the index with junk ids.
 *
 * Minimum 22 chars after the `s_` prefix = ≥128 bits of entropy (UUID
 * strength). Anything shorter is brute-forceable by an attacker who wants
 * to race the legit SDK's first ingest call (Phase F end_user poisoning
 * vector — see route.ts COALESCE comment).
 */
const SESSION_ID_RE = /^s_[A-Za-z0-9_-]{22,128}$/;

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

// Phase G — Core Web Vitals snapshot extracted from the SDK's _kind:vital events.
// One entry per metric name; later events with the same name overwrite earlier
// ones (vitals settle on tab hide, so the last value is the canonical one).
export type WebVitalsSnapshot = Partial<Record<
  "LCP" | "CLS" | "INP" | "FCP" | "TTFB",
  { value: number; rating: "good" | "needs-improvement" | "poor" }
>>;

export function extractWebVitals(events: unknown[]): WebVitalsSnapshot {
  const out: WebVitalsSnapshot = {};
  const validNames = new Set(["LCP", "CLS", "INP", "FCP", "TTFB"]);
  const validRatings = new Set(["good", "needs-improvement", "poor"]);
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as { _kind?: string; name?: string; value?: number; rating?: string };
    if (e._kind !== "vital") continue;
    if (!e.name || !validNames.has(e.name)) continue;
    if (typeof e.value !== "number" || !Number.isFinite(e.value) || e.value < 0) continue;
    if (!e.rating || !validRatings.has(e.rating)) continue;
    out[e.name as keyof WebVitalsSnapshot] = {
      value: e.value,
      rating: e.rating as "good" | "needs-improvement" | "poor",
    };
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
