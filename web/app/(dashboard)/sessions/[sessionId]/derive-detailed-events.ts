/**
 * Pure transformation: raw rrweb event stream → typed `DetailedEvent[]`.
 *
 * The replay viewer has two parallel event representations:
 *   - `timelineEvents`: `{ timestamp, kind }` only. Small, fast to iterate
 *     for the canvas render loop. Rebuilt on every `events` change.
 *   - `detailedEvents`: full metadata preserved. Drives the side panels
 *     (console, network) and the URL breadcrumb strip. Also pure so it
 *     can be unit-tested without a browser.
 *
 * Keeping the two separate avoids widening the canvas prop surface with
 * payload data it doesn't read — the timeline only cares about
 * `{x, kind}` for drawing dots, not about what a network request returned.
 *
 * Timestamps are RELATIVE to `sessionStartMs` so `currentMs` matches.
 */

export type DetailedEvent =
  | {
      kind: "console";
      timestamp: number;
      level: "error" | "warn" | "info" | "log";
      message: string;
    }
  | {
      kind: "network";
      timestamp: number;
      method: string;
      url: string;
      status?: number;
      durationMs?: number;
      errorMessage?: string;
      // Phase I.d — captured bodies (only present when project opted in
      // AND the URL passed the denylist AND the content-type is text-ish).
      requestBody?: { text: string; truncated: boolean; originalBytes: number };
      responseBody?: { text: string; truncated: boolean; originalBytes: number };
      requestHeaders?: Record<string, string>;
      responseHeaders?: Record<string, string>;
      bodyOmittedReason?: string;
    }
  | {
      kind: "nav";
      timestamp: number;
      href: string;
      width?: number;
      height?: number;
    }
  | {
      kind: "error";
      timestamp: number;
      fingerprint: string;
      message: string;
    };

/**
 * Walk the raw event stream once and materialize the four detail-bearing
 * kinds. rrweb DOM mutations (type 3) are skipped — they're represented
 * only on the timeline, not in any panel.
 *
 * @param events  Raw rrweb + custom `_kind` events merged from session blocks.
 * @param sessionStartMs  Absolute timestamp (from `manifest.startedAt`)
 *   used to convert each event's wall-clock `timestamp` into a
 *   playback-relative offset.
 */
export function deriveDetailedEvents(
  events: unknown[],
  sessionStartMs: number,
): DetailedEvent[] {
  const out: DetailedEvent[] = [];

  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as {
      _kind?: string;
      type?: number;
      timestamp?: number;
      data?: Record<string, unknown>;
    };
    const absTs = typeof e.timestamp === "number" ? e.timestamp : 0;
    const relTs = Math.max(0, absTs - sessionStartMs);

    if (e._kind === "console") {
      const c = raw as { level?: string; message?: string };
      out.push({
        kind: "console",
        timestamp: relTs,
        level: normalizeConsoleLevel(c.level),
        message: typeof c.message === "string" ? c.message : "",
      });
      continue;
    }

    if (e._kind === "network") {
      const n = raw as {
        method?: string;
        url?: string;
        status?: number;
        durationMs?: number;
        errorMessage?: string;
        requestBody?: unknown;
        responseBody?: unknown;
        requestHeaders?: unknown;
        responseHeaders?: unknown;
        bodyOmittedReason?: unknown;
      };
      out.push({
        kind: "network",
        timestamp: relTs,
        method: typeof n.method === "string" ? n.method : "GET",
        url: typeof n.url === "string" ? n.url : "",
        status: typeof n.status === "number" ? n.status : undefined,
        durationMs: typeof n.durationMs === "number" ? n.durationMs : undefined,
        errorMessage: typeof n.errorMessage === "string" ? n.errorMessage : undefined,
        requestBody: validBody(n.requestBody),
        responseBody: validBody(n.responseBody),
        requestHeaders: validHeaders(n.requestHeaders),
        responseHeaders: validHeaders(n.responseHeaders),
        bodyOmittedReason: typeof n.bodyOmittedReason === "string" ? n.bodyOmittedReason : undefined,
      });
      continue;
    }

    if (e._kind === "error") {
      const err = raw as { fingerprint?: string; message?: string };
      out.push({
        kind: "error",
        timestamp: relTs,
        fingerprint: typeof err.fingerprint === "string" ? err.fingerprint : "",
        message: typeof err.message === "string" ? err.message : "",
      });
      continue;
    }

    // SPA navigation event emitted by the capture SDK's history.pushState
    // hook (capture-replay/src/replay.ts attachNavWatcher). Without this
    // branch SPAs would only show their initial URL because rrweb's meta
    // event (type 4) doesn't fire on client-side route changes.
    if (e._kind === "nav") {
      const n = raw as { href?: string };
      if (typeof n.href === "string") {
        out.push({ kind: "nav", timestamp: relTs, href: n.href });
      }
      continue;
    }

    // rrweb meta event (type 4) carries href on the initial snapshot AND
    // on any re-checkout triggered by `checkoutEveryNms`. Used as the
    // session's first nav entry — the SDK's pushState watcher takes over
    // from there for subsequent route changes.
    if (e.type === 4 && e.data && typeof e.data === "object") {
      const d = e.data as { href?: string; width?: number; height?: number };
      if (typeof d.href === "string") {
        out.push({
          kind: "nav",
          timestamp: relTs,
          href: d.href,
          width: typeof d.width === "number" ? d.width : undefined,
          height: typeof d.height === "number" ? d.height : undefined,
        });
      }
    }
  }

  // Events arrive in chronological order from the block merge, but a
  // defensive sort makes this function robust to future ingest changes
  // (e.g. out-of-order block arrival) without callers having to care.
  out.sort((a, b) => a.timestamp - b.timestamp);
  return out;
}

/** Defensive shape guard for the body fields shipped by the SDK — lets the
 *  panel render confidently without re-validating per render. */
function validBody(raw: unknown):
  | { text: string; truncated: boolean; originalBytes: number }
  | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const b = raw as { text?: unknown; truncated?: unknown; originalBytes?: unknown };
  if (typeof b.text !== "string") return undefined;
  return {
    text: b.text,
    truncated: b.truncated === true,
    originalBytes: typeof b.originalBytes === "number" ? b.originalBytes : b.text.length,
  };
}

/** Headers as a flat record (already redacted client-side). */
function validHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeConsoleLevel(raw: unknown): "error" | "warn" | "info" | "log" {
  if (raw === "error") return "error";
  if (raw === "warn") return "warn";
  if (raw === "info") return "info";
  return "log";
}

/**
 * Binary search for the latest detailed event at or before `currentMs`.
 * Used by panels to highlight the "active" row during playback without
 * re-scanning the whole array every RAF tick.
 *
 * Returns -1 if no event has fired yet at this time.
 */
export function findActiveIndex(events: DetailedEvent[], currentMs: number): number {
  if (events.length === 0) return -1;
  let lo = 0;
  let hi = events.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].timestamp <= currentMs) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
