/**
 * FullTrace session id extraction — server side.
 *
 * Pairs with capture/src/fulltrace.ts (the SDK that propagates the header).
 * The id is the link that ties together browser session, server-side I/O
 * (Substrate), and any alerts that come from the same user flow.
 *
 * Resolution order on the server:
 *   1. `X-IW-Session-Id` request header (canonical — set by SDK fetch interceptor)
 *   2. `metadata.sessionId` on the parsed event payload (fallback for transports
 *      that bypass the fetch interceptor, e.g. navigator.sendBeacon, XHR
 *      libraries, third-party SDKs)
 *   3. `metadata.replaySessionId` (legacy — replay v2 wrote this before
 *      FullTrace existed; keep accepting it so old SDK versions still
 *      correlate to existing replay rows)
 *
 * Returns null when nothing is found. Callers should treat null as "this
 * request is not part of a tracked session" and proceed without correlation
 * — never throw, never error log. Most server-to-server traffic (cron jobs,
 * pollers, internal webhooks) will have no session id and that's fine.
 */

const HEADER_NAME = "x-iw-session-id"
/** Loose UUID-ish guard. We accept anything 8–64 chars of safe URL alphabet so
 *  that hosts using their own session schemes (e.g. ULID, NanoID, hashed user
 *  id) still work — strict UUID validation would lock them out. The bound
 *  prevents pathological payloads from poisoning the index. */
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/

/** Read X-IW-Session-Id from a Request or Headers object. */
export function readSessionHeader(req: Request | Headers): string | null {
  const headers = req instanceof Headers ? req : req.headers
  const raw = headers.get(HEADER_NAME)
  if (!raw) return null
  const trimmed = raw.trim()
  return ID_RE.test(trimmed) ? trimmed : null
}

/** Read sessionId from a parsed capture SDK event payload. */
export function readSessionMetadata(event: Record<string, unknown> | undefined): string | null {
  if (!event) return null
  const meta = event.metadata as Record<string, unknown> | undefined
  if (!meta) return null
  const sessionId = (meta.sessionId as string | undefined) ?? (meta.replaySessionId as string | undefined)
  if (typeof sessionId !== "string") return null
  const trimmed = sessionId.trim()
  return ID_RE.test(trimmed) ? trimmed : null
}

/**
 * Combined helper — checks header first, then payload metadata. Returns null
 * when neither is present. Use this from API routes that ingest capture events.
 */
export function extractSessionId(
  req: Request | Headers,
  event?: Record<string, unknown>,
): string | null {
  return readSessionHeader(req) ?? readSessionMetadata(event)
}
