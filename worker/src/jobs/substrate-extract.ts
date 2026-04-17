/**
 * Substrate Extract — VAR Gate 13 feeder.
 *
 * Runs once per substrate_recordings row, right after
 * /api/recordings/upload persists the row. Walks the events JSONB,
 * derives a per-endpoint summary (latency, db query count, external http
 * count, downstream signatures, top status), and upserts rows into
 * session_endpoint_metrics so Gate 13 can compute percentile baselines
 * on demand.
 *
 * The extraction is intentionally minimal for v1 — one endpoint row per
 * recording, picked as the first http_request in the stream. All
 * subsequent http_request events count as external downstream; all
 * db_query events count as db_query downstream. Recordings that have no
 * http_request at all are skipped (nothing to group on). This matches
 * the Capture SDK's per-request scoping via AsyncLocalStorage: one
 * recording ≈ one inbound endpoint interaction.
 *
 * `healthy` is derived here from two signals — the recording has no
 * associated alert AND no error-kind events fired during capture.
 * Unhealthy rows still land in the table (we keep them for future
 * trend-delta work) but Gate 13's baseline query filters them out
 * via the partial index.
 */

import { eq } from "drizzle-orm";
import {
  db,
  substrateRecordings,
  sessionEndpointMetrics,
} from "../db.js";

export interface SubstrateExtractInput {
  /** substrate_recordings.id — the row we're extracting from. */
  recordingId: string;
}

// Narrow shape of an event we care about. The stream may contain other
// kinds we ignore (fs, net, tls, etc.).
interface SubEvent {
  seq?: number;
  timestamp_ns?: number;
  kind?: {
    type?: string;
    id?: number;
    method?: string;
    url?: string;
    status?: number;
    query?: string;
    system?: string;
  };
}

interface ExtractedEndpoint {
  signature: string;
  urlRaw: string;
  latencyMs: number | null;
  dbQueryCount: number;
  externalHttpCount: number;
  topStatus: number | null;
  downstreamSignatures: string[];
}

// ── Main handler ──────────────────────────────────────────────────────────

export async function runSubstrateExtract({ recordingId }: SubstrateExtractInput): Promise<void> {
  const [rec] = await db
    .select({
      id: substrateRecordings.id,
      projectId: substrateRecordings.projectId,
      alertId: substrateRecordings.alertId,
      startedAt: substrateRecordings.startedAt,
      events: substrateRecordings.events,
    })
    .from(substrateRecordings)
    .where(eq(substrateRecordings.id, recordingId))
    .limit(1);

  if (!rec) {
    console.warn(`[substrate-extract] recording ${recordingId} not found`);
    return;
  }
  // Need project scope for baseline aggregation, and a timestamp for the
  // rolling window. Recordings missing either are unusable for drift.
  if (!rec.projectId || !rec.startedAt) {
    console.log(`[substrate-extract] ${recordingId} skipped: missing projectId or startedAt`);
    return;
  }

  const rawEvents = Array.isArray(rec.events) ? (rec.events as SubEvent[]) : [];
  if (rawEvents.length === 0) {
    console.log(`[substrate-extract] ${recordingId} skipped: zero events`);
    return;
  }

  const extracted = extractEndpointMetrics(rawEvents);
  if (extracted.length === 0) {
    console.log(`[substrate-extract] ${recordingId} skipped: no http_request to group on`);
    return;
  }

  const hasErrorEvent = rawEvents.some((e) => e.kind?.type === "error");
  const healthy = rec.alertId === null && !hasErrorEvent;

  const rows = extracted.map((m) => ({
    substrateRecordingId: rec.id,
    projectId: rec.projectId!,
    endpointSignature: m.signature,
    endpointUrlRaw: m.urlRaw,
    capturedAt: rec.startedAt!,
    healthy,
    latencyMs: m.latencyMs,
    dbQueryCount: m.dbQueryCount,
    externalHttpCount: m.externalHttpCount,
    topStatus: m.topStatus,
    downstreamSignatures: m.downstreamSignatures,
  }));

  // onConflictDoNothing — if a re-enqueue happens for the same recording
  // (retry, double-fire), the UNIQUE(recording, signature) constraint
  // silently keeps the first write. Extraction is deterministic so a
  // re-extract would produce the same row anyway.
  await db
    .insert(sessionEndpointMetrics)
    .values(rows)
    .onConflictDoNothing();

  console.log(
    `[substrate-extract] ${recordingId}: ${rows.length} endpoint(s), healthy=${healthy}, signature=${rows[0]!.endpointSignature}`,
  );
}

// ── Extraction ────────────────────────────────────────────────────────────

function extractEndpointMetrics(events: SubEvent[]): ExtractedEndpoint[] {
  let topRequest: { id: number; method: string; url: string; tsNs: number } | null = null;
  let topResponse: { status: number; tsNs: number } | null = null;
  let dbQueryCount = 0;
  let externalHttpCount = 0;
  const downstreams = new Set<string>();

  for (const e of events) {
    const k = e.kind;
    if (!k?.type) continue;
    const t = k.type;

    if (t === "http_request") {
      const url = typeof k.url === "string" ? k.url : "";
      const method = typeof k.method === "string" ? k.method : "GET";
      const id = typeof k.id === "number" ? k.id : null;
      const tsNs = typeof e.timestamp_ns === "number" ? e.timestamp_ns : null;

      if (topRequest === null && id !== null && tsNs !== null) {
        // First http_request drives the endpoint identity.
        topRequest = { id, method, url, tsNs };
      } else if (topRequest !== null) {
        // Every subsequent http_request is an external downstream call.
        externalHttpCount++;
        if (url.length > 0) {
          downstreams.add(stripQuery(url));
        }
      }
    } else if (t === "http_response") {
      const id = typeof k.id === "number" ? k.id : null;
      const tsNs = typeof e.timestamp_ns === "number" ? e.timestamp_ns : null;
      const status = typeof k.status === "number" ? k.status : null;
      // Pair only with the top request — subsequent responses belong to
      // downstream calls we're counting above.
      if (
        topRequest !== null &&
        topResponse === null &&
        id === topRequest.id &&
        tsNs !== null &&
        status !== null
      ) {
        topResponse = { status, tsNs };
      }
    } else if (t === "db_query") {
      dbQueryCount++;
      const query = typeof k.query === "string" ? k.query : "";
      downstreams.add(dbQuerySignature(query));
    }
  }

  if (topRequest === null) return [];

  const signature = `${topRequest.method} ${normalizeRoute(topRequest.url)}`;
  const latencyMs =
    topResponse !== null ? (topResponse.tsNs - topRequest.tsNs) / 1_000_000 : null;

  return [
    {
      signature,
      urlRaw: topRequest.url,
      // Negative latency = clock skew or bad pairing. Drop to null so
      // the baseline percentile skips it rather than poisoning the bucket.
      latencyMs: latencyMs !== null && latencyMs >= 0 ? latencyMs : null,
      dbQueryCount,
      externalHttpCount,
      topStatus: topResponse?.status ?? null,
      downstreamSignatures: [...downstreams].sort(),
    },
  ];
}

// ── URL/query normalizers ─────────────────────────────────────────────────

/**
 * Normalize a request URL into a stable route signature.
 *   /api/users/abc-123-def/orders/42?x=1  →  /api/users/:id/orders/:id
 * Strips scheme+host when present so "https://api.x.com/v1/foo" and
 * "/v1/foo" collapse to the same signature.
 */
function normalizeRoute(url: string): string {
  if (!url) return "/";
  const noQuery = stripQuery(url);
  const schemeIdx = noQuery.indexOf("://");
  let path: string;
  if (schemeIdx >= 0) {
    const pathStart = noQuery.indexOf("/", schemeIdx + 3);
    path = pathStart >= 0 ? noQuery.slice(pathStart) : "/";
  } else {
    path = noQuery;
  }
  if (path.length === 0) return "/";
  const normalized = path
    .split("/")
    .map((seg) => {
      if (seg.length === 0) return seg;
      if (/^\d+$/.test(seg)) return ":id";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) {
        return ":id";
      }
      return seg;
    })
    .join("/");
  return normalized || "/";
}

function stripQuery(url: string): string {
  const q = url.indexOf("?");
  return q >= 0 ? url.slice(0, q) : url;
}

/**
 * Build a downstream signature for a SQL query:
 *   "SELECT * FROM users WHERE id = $1"  →  "postgres:SELECT users"
 * Best-effort — unknown shapes fall back to "postgres:<verb> unknown".
 */
function dbQuerySignature(query: string): string {
  const trimmed = query.trim();
  if (trimmed.length === 0) return "postgres:unknown";
  const verb = (trimmed.split(/\s+/)[0] ?? "").toUpperCase();
  const tableMatch = trimmed.match(/(?:FROM|INTO|UPDATE|JOIN)\s+["`]?([\w.]+)["`]?/i);
  const table = tableMatch?.[1] ?? "unknown";
  return `postgres:${verb || "UNKNOWN"} ${table}`;
}
