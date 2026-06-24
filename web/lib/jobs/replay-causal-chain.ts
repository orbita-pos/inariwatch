/**
 * Causal-chain detection for replay sessions.
 *
 * Given a mixed event stream (rrweb DOM + network + console + errors +
 * substrate backend I/O), walk backwards from each error event to find the
 * user action that triggered it. The resulting chain powers:
 *
 *  1. The timeline UI — a dashed connector links the clicked selector to
 *     the HTTP request to the failing DB query to the error marker.
 *  2. The AI chapters — "🔴 Error: user clicked 'Submit' → POST /api/users
 *     → INSERT users timed out".
 *
 * Pure function: takes events, returns chain. Zero DB / network / rrweb
 * dependencies so it's trivially unit-testable.
 */

export type CausalRole = "user_action" | "http_cause" | "db_cause" | "error";

export interface CausalLink {
  role: CausalRole;
  timestamp: number;
  summary: string;
  /** Index of the source event in the input array — useful for UI highlighting. */
  eventIndex: number;
}

export interface CausalChain {
  errorFingerprint: string;
  links: CausalLink[];
}

// ── Event shape guards ───────────────────────────────────────────────────────
// We inspect events by shape rather than typing them strictly, because the
// stream mixes rrweb events (numeric type) with our tagged events (_kind).

interface ErrorEventShape {
  _kind: "error";
  timestamp: number;
  fingerprint: string;
  message?: string;
}

interface NetworkEventShape {
  _kind: "network";
  timestamp: number;
  method?: string;
  url?: string;
  status?: number;
  durationMs?: number;
  traceId?: string;
}

interface SubstrateEventShape {
  _kind: "substrate";
  timestamp: number;
  kind?: { type?: string; query?: string; url?: string; trace_id?: string };
  traceId?: string;
}

interface RrwebClickEvent {
  type: 3;
  timestamp: number;
  data: { source: 2; type: 2; selector?: string };
}

function isErrorEvent(e: unknown): e is ErrorEventShape {
  return !!e && typeof e === "object" && (e as { _kind?: string })._kind === "error";
}

function isNetworkEvent(e: unknown): e is NetworkEventShape {
  return !!e && typeof e === "object" && (e as { _kind?: string })._kind === "network";
}

function isSubstrateEvent(e: unknown): e is SubstrateEventShape {
  return !!e && typeof e === "object" && (e as { _kind?: string })._kind === "substrate";
}

function isRrwebClick(e: unknown): e is RrwebClickEvent {
  if (!e || typeof e !== "object") return false;
  const ev = e as { type?: number; data?: { source?: number; type?: number } };
  return ev.type === 3 && ev.data?.source === 2 && ev.data?.type === 2;
}

// ── Chain walkers ────────────────────────────────────────────────────────────

function findLastBefore<T>(
  events: unknown[],
  cutoffTs: number,
  predicate: (ev: unknown) => ev is T,
): { event: T; index: number } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!predicate(e)) continue;
    const ts = (e as { timestamp?: number }).timestamp ?? Infinity;
    if (ts < cutoffTs) return { event: e, index: i };
  }
  return null;
}

function summarizeNetwork(e: NetworkEventShape): string {
  const method = e.method ?? "GET";
  const url = e.url ? e.url.slice(0, 120) : "unknown";
  return e.status ? `${method} ${url} → ${e.status}` : `${method} ${url}`;
}

function summarizeSubstrate(e: SubstrateEventShape): string {
  const t = e.kind?.type ?? "unknown";
  if (t === "DbQuery" && e.kind?.query) return `DB: ${e.kind.query.slice(0, 120)}`;
  if (t === "HttpRequest" && e.kind?.url) return `HTTP: ${e.kind.url.slice(0, 120)}`;
  return t;
}

/**
 * Build the causal chain ending at the given error event.
 *
 * Walks backwards: error → last DB query → HTTP request sharing its trace
 * (if present) → last click before that request. Every link is optional —
 * we ship the chain even if only some links can be reconstructed.
 */
function buildChainForError(
  events: unknown[],
  errorIdx: number,
  errorEv: ErrorEventShape,
): CausalChain {
  const links: CausalLink[] = [];
  const errorTs = errorEv.timestamp;

  // Anchor: the error itself
  const errorLink: CausalLink = {
    role: "error",
    timestamp: errorTs,
    summary: errorEv.message ? errorEv.message.slice(0, 200) : "Error",
    eventIndex: errorIdx,
  };

  // 1. Look for a DB query shortly before the error (backend cause)
  const dbHit = findLastBefore(
    events,
    errorTs,
    (e): e is SubstrateEventShape => isSubstrateEvent(e) && e.kind?.type === "DbQuery",
  );
  if (dbHit) {
    links.push({
      role: "db_cause",
      timestamp: dbHit.event.timestamp,
      summary: summarizeSubstrate(dbHit.event),
      eventIndex: dbHit.index,
    });
  }

  // 2. HTTP request — prefer the one matching the DB query's trace id,
  //    otherwise the last HTTP before the error.
  const targetTraceId = dbHit?.event.kind?.trace_id ?? dbHit?.event.traceId ?? null;
  let httpHit = null as ReturnType<typeof findLastBefore<NetworkEventShape>> | ReturnType<typeof findLastBefore<SubstrateEventShape>>;
  if (targetTraceId) {
    httpHit = findLastBefore(
      events,
      errorTs,
      (e): e is NetworkEventShape => isNetworkEvent(e) && (e.traceId === targetTraceId),
    );
  }
  if (!httpHit) {
    // Fall back to any network request before the error (likely the failing one)
    // Prefer ones with error status or thrown errors.
    httpHit = findLastBefore(
      events,
      errorTs,
      (e): e is NetworkEventShape => isNetworkEvent(e) && (
        typeof (e as NetworkEventShape).status !== "number" ||
        (e as NetworkEventShape).status! >= 400
      ),
    ) ?? findLastBefore(events, errorTs, isNetworkEvent);
  }
  if (httpHit && httpHit.event) {
    const net = httpHit.event as NetworkEventShape | SubstrateEventShape;
    const summary = isNetworkEvent(net) ? summarizeNetwork(net) : summarizeSubstrate(net);
    links.push({
      role: "http_cause",
      timestamp: net.timestamp,
      summary,
      eventIndex: httpHit.index,
    });
  }

  // 3. User action — the last click before the triggering HTTP (or the error
  //    directly if no HTTP was found). Capture from rrweb click events.
  const clickCutoff = httpHit?.event.timestamp ?? errorTs;
  const clickHit = findLastBefore(events, clickCutoff, isRrwebClick);
  if (clickHit) {
    const selector = clickHit.event.data.selector ?? "(unknown element)";
    links.push({
      role: "user_action",
      timestamp: clickHit.event.timestamp,
      summary: `click ${selector.slice(0, 120)}`,
      eventIndex: clickHit.index,
    });
  }

  // Chain reads naturally in forward time: user → http → db → error
  links.reverse();
  links.push(errorLink);

  return { errorFingerprint: errorEv.fingerprint, links };
}

/**
 * Detect causal chains for every error event in the stream. Returns one
 * chain per distinct error fingerprint — if an error repeats, only the
 * first occurrence gets a chain (subsequent ones are usually duplicates).
 */
export function detectCausalChains(events: unknown[]): CausalChain[] {
  if (!Array.isArray(events) || events.length === 0) return [];
  const seen = new Set<string>();
  const chains: CausalChain[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!isErrorEvent(e)) continue;
    if (seen.has(e.fingerprint)) continue;
    seen.add(e.fingerprint);
    chains.push(buildChainForError(events, i, e));
  }
  return chains;
}

/**
 * Shorter convenience — just the first chain (used for the AI prompt context).
 */
export function detectFirstCausalChain(events: unknown[]): CausalChain | null {
  const chains = detectCausalChains(events);
  return chains[0] ?? null;
}
