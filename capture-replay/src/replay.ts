/**
 * Replay V2 — continuous DOM event streaming to InariWatch cloud.
 *
 * Captures full rrweb event stream (not just filtered subset like session.ts),
 * batches into 30-second blocks, and POSTs to /api/replay/ingest. Each block
 * is stored as a gzipped object in Cloudflare R2 and can be scrubbed frame-by-frame
 * in the dashboard player.
 *
 * Browser-only. rrweb is loaded dynamically (optional peer dep) so Node users
 * pay zero bundle cost.
 *
 * Correlation with backend: exposes window.__INARIWATCH_SESSION__ and patches
 * fetch() to propagate the session id as `x-inariwatch-session` header on
 * same-origin requests. The server attaches that id to any errors it captures.
 */

import type { CaptureConfig } from "@inariwatch/capture"
import { classifyField, shouldMask, isUncertain, hashFeatures, type FieldFeatures, type Classification, type PiiCategory } from "./pii-classifier.js"

/**
 * Replay recording options. Lives here (not in core capture) so users who
 * only need error tracking pay zero tokens for the type.
 */
export interface ReplayConfig {
  /** Flush interval in seconds (default: 30) */
  blockDurationSec?: number
  /** Max buffer bytes before forced flush (default: 262144 = 256 KB) */
  maxBufferBytes?: number
  /** Override the endpoint (default: parsed from DSN or https://app.inariwatch.com) */
  endpoint?: string
  /**
   * Mask all input values. Default behavior:
   *   - `true`  when `piiClassifier` is `false` — safer fallback.
   *   - `false` when `piiClassifier` is `"heuristic"` or `"ai"` — the classifier decides per field.
   * Explicitly setting this overrides both defaults.
   */
  maskAllInputs?: boolean
  /** CSS selectors whose text content should be redacted */
  redactSelectors?: string[]
  /**
   * PII classifier strategy:
   *   - `"ai"` (default) — heuristics first, server AI for ambiguous fields.
   *   - `"heuristic"` — client-side rules only, zero network cost.
   *   - `false` — disabled; falls back to `maskAllInputs: true` for safety.
   */
  piiClassifier?: "ai" | "heuristic" | false
}

const DEFAULT_BLOCK_DURATION_SEC = 30
const DEFAULT_MAX_BUFFER_BYTES = 256 * 1024 // 256 KB
const MAX_EVENTS_PER_BLOCK = 10_000 // server-side limit

let replayActive = false
let currentSessionId: string | null = null

interface ReplayState {
  sessionId: string
  projectId: string
  endpoint: string
  blockIndex: number
  buffer: unknown[]
  bufferBytes: number
  blockStartMs: number
  sessionStartMs: number
  timer: ReturnType<typeof setInterval> | null
  debug: boolean
}

let state: ReplayState | null = null

function generateSessionId(): string {
  // crypto.randomUUID available in modern browsers (Chrome 92+, Safari 15.4+)
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `s_${crypto.randomUUID()}`
  }
  // Fallback: 128 random bits encoded as hex
  const bytes = new Uint8Array(16)
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return `s_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`
}

/** Get current session id (null if replay not active). Exposed for tests. */
export function getSessionId(): string | null {
  return currentSessionId
}

function getEndpoint(config: CaptureConfig, replayConfig: ReplayConfig): string {
  if (replayConfig.endpoint) return replayConfig.endpoint.replace(/\/$/, "")
  if (config.dsn) {
    try {
      const u = new URL(config.dsn)
      return `${u.protocol}//${u.host}`
    } catch {
      // fall through
    }
  }
  return "https://app.inariwatch.com"
}

/**
 * POST the current buffer as a replay block. Swallows errors — replay is
 * best-effort and must never crash the host app.
 */
async function flushBlock(opts: { isFinal: boolean } = { isFinal: false }): Promise<void> {
  if (!state || state.buffer.length === 0) return

  const events = state.buffer
  const myIndex = state.blockIndex
  const myBlockStart = state.blockStartMs - state.sessionStartMs
  const myBlockEnd = Date.now() - state.sessionStartMs

  // Reset buffer before network call so new events land in the next block
  state.buffer = []
  state.bufferBytes = 0
  state.blockIndex = myIndex + 1
  state.blockStartMs = Date.now()

  const body = {
    sessionId: state.sessionId,
    projectId: state.projectId,
    blockIndex: myIndex,
    startMs: Math.max(0, myBlockStart),
    endMs: myBlockEnd,
    events,
    metadata: {
      startedAt: state.sessionStartMs,
      endedAt: opts.isFinal ? Date.now() : undefined,
      browser: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 200) : undefined,
      os: typeof navigator !== "undefined" ? inferOS(navigator.userAgent) : undefined,
      viewport: typeof window !== "undefined" ? {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio,
      } : undefined,
      isFinal: opts.isFinal,
    },
  }

  const url = `${state.endpoint}/api/replay/ingest`
  const payload = JSON.stringify(body)

  // On page unload, sendBeacon is the only reliable transport
  if (opts.isFinal && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    try {
      const blob = new Blob([payload], { type: "application/json" })
      navigator.sendBeacon(url, blob)
      return
    } catch {
      // fall through to fetch
    }
  }

  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      keepalive: opts.isFinal,
    })
  } catch (err) {
    if (state?.debug) {
      console.warn("[@inariwatch/capture/replay] flush failed:", err instanceof Error ? err.message : err)
    }
  }
}

function inferOS(ua: string): string | undefined {
  if (/Windows/i.test(ua)) return "Windows"
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS"
  if (/Android/i.test(ua)) return "Android"
  if (/iPhone|iPad|iOS/i.test(ua)) return "iOS"
  if (/Linux/i.test(ua)) return "Linux"
  return undefined
}

/**
 * Non-rrweb events emitted into the buffer. Prefixed with `_kind` so the
 * server-side indexer + causal chain detector can distinguish them from
 * rrweb DOM snapshots (which use numeric `type` field).
 */
type NetworkEvent = { _kind: "network"; timestamp: number; method: string; url: string; status?: number; durationMs?: number; errorMessage?: string }
type ConsoleEvent = { _kind: "console"; timestamp: number; level: "error" | "warn"; message: string }
type ErrorCaptureEvent = { _kind: "error"; timestamp: number; fingerprint: string; message: string; stack?: string; source?: string; line?: number; col?: number }

function pushCustomEvent(ev: NetworkEvent | ConsoleEvent | ErrorCaptureEvent): void {
  if (!state) return
  state.buffer.push(ev)
  state.bufferBytes += 300
}

/** Compute a short fingerprint for grouping identical errors across a session. */
function fingerprintError(message: string, stack?: string): string {
  // Use first stack frame (or message) — stable enough for session dedup.
  const topFrame = stack?.split("\n")[1]?.trim() ?? ""
  const base = `${message.slice(0, 200)}|${topFrame.slice(0, 200)}`
  let hash = 5381
  for (let i = 0; i < base.length; i++) hash = ((hash << 5) + hash) ^ base.charCodeAt(i)
  return Math.abs(hash).toString(36)
}

/**
 * Patch global fetch so:
 *  1. Same-origin requests get a session correlation header.
 *  2. Request/response outcomes are emitted as network events in the stream,
 *     which the causal chain detector uses to trace error → request → click.
 * Cross-origin requests skip the header (avoids CORS preflight) but still
 * get timed so they appear in the Network track.
 */
function patchFetch(sessionId: string): void {
  if (typeof globalThis === "undefined" || typeof globalThis.fetch !== "function") return
  const orig = globalThis.fetch
  if ((orig as { __inariwatchPatched?: boolean }).__inariwatchPatched) return

  const patched: typeof fetch = async (input, init) => {
    const started = Date.now()
    let url = ""
    let method = "GET"
    try {
      url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    } catch {
      // If we can't introspect the input, just pass through
      return orig(input, init)
    }

    // Never patch our own ingest URL — would recurse
    if (url.includes("/api/replay/ingest")) return orig(input, init)

    const isSameOrigin = typeof window !== "undefined"
      ? !url.startsWith("http") || url.startsWith(window.location.origin)
      : true

    let finalInit: RequestInit | undefined = init
    if (isSameOrigin) {
      try {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
        if (!headers.has("x-inariwatch-session")) {
          headers.set("x-inariwatch-session", sessionId)
        }
        finalInit = { ...init, headers }
      } catch {
        // fall through with original init
      }
    }

    try {
      const resp = await orig(input, finalInit)
      pushCustomEvent({
        _kind: "network",
        timestamp: started,
        method,
        url: url.slice(0, 500),
        status: resp.status,
        durationMs: Date.now() - started,
      })
      return resp
    } catch (err) {
      pushCustomEvent({
        _kind: "network",
        timestamp: started,
        method,
        url: url.slice(0, 500),
        durationMs: Date.now() - started,
        errorMessage: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      })
      throw err
    }
  }

  ;(patched as { __inariwatchPatched?: boolean }).__inariwatchPatched = true
  globalThis.fetch = patched
}

/**
 * Patch console.error / console.warn to mirror entries into the replay stream.
 * Calls the original console first so the user's own devtools still see logs.
 */
function patchConsole(): void {
  if (typeof console === "undefined") return
  if ((console as { __inariwatchPatched?: boolean }).__inariwatchPatched) return

  const origError = console.error.bind(console)
  const origWarn = console.warn.bind(console)

  console.error = (...args: unknown[]) => {
    try {
      pushCustomEvent({
        _kind: "console",
        timestamp: Date.now(),
        level: "error",
        message: args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" ").slice(0, 500),
      })
    } catch {
      // Never fail the original console call
    }
    origError(...args)
  }

  console.warn = (...args: unknown[]) => {
    try {
      pushCustomEvent({
        _kind: "console",
        timestamp: Date.now(),
        level: "warn",
        message: args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" ").slice(0, 500),
      })
    } catch {
      // Never fail the original console call
    }
    origWarn(...args)
  }

  ;(console as { __inariwatchPatched?: boolean }).__inariwatchPatched = true
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Capture uncaught errors and unhandled promise rejections. Each error lands
 * in the replay stream as an `_kind: "error"` event with a short fingerprint
 * — this is what /api/replay/ingest pulls into error_fingerprints[].
 */
function attachErrorHandlers(): void {
  if (typeof window === "undefined") return
  if ((window as { __inariwatchErrorsPatched?: boolean }).__inariwatchErrorsPatched) return

  window.addEventListener("error", (event) => {
    try {
      const err = event.error
      const message = event.message || (err instanceof Error ? err.message : String(err))
      const stack = err instanceof Error ? err.stack : undefined
      pushCustomEvent({
        _kind: "error",
        timestamp: Date.now(),
        fingerprint: fingerprintError(message, stack),
        message: String(message).slice(0, 500),
        stack: stack?.slice(0, 2000),
        source: event.filename?.slice(0, 300),
        line: event.lineno,
        col: event.colno,
      })
    } catch {
      // Error in error handler — swallow
    }
  })

  window.addEventListener("unhandledrejection", (event) => {
    try {
      const reason = event.reason
      const message = reason instanceof Error ? reason.message : String(reason)
      const stack = reason instanceof Error ? reason.stack : undefined
      pushCustomEvent({
        _kind: "error",
        timestamp: Date.now(),
        fingerprint: fingerprintError(message, stack),
        message: `Unhandled rejection: ${message}`.slice(0, 500),
        stack: stack?.slice(0, 2000),
      })
    } catch {
      // swallow
    }
  })

  ;(window as { __inariwatchErrorsPatched?: boolean }).__inariwatchErrorsPatched = true
}

/**
 * Initialize replay recording. Browser-only, no-ops in Node. Idempotent
 * (second call is ignored). Never throws — all errors are logged in debug mode.
 */
export async function initReplay(
  replayConfig: ReplayConfig,
  captureConfig: CaptureConfig,
): Promise<void> {
  if (typeof window === "undefined") return
  if (replayActive) return

  if (!captureConfig.projectId) {
    if (!captureConfig.silent) {
      console.warn("[@inariwatch/capture/replay] replay: true but projectId is missing. Set config.projectId.")
    }
    return
  }

  const blockDurationSec = replayConfig.blockDurationSec ?? DEFAULT_BLOCK_DURATION_SEC
  const maxBufferBytes = replayConfig.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES

  let record: ((opts: Record<string, unknown>) => unknown) | null = null
  try {
    // Dynamic import — rrweb is an optional peer dep
    const pkg = "rrweb"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rrweb: any = await import(/* webpackIgnore: true */ pkg)
    record = rrweb.record ?? rrweb.default?.record ?? null
  } catch {
    if (!captureConfig.silent) {
      console.warn("[@inariwatch/capture/replay] replay: true but rrweb not installed. Run: npm install rrweb")
    }
    return
  }

  if (!record) {
    if (!captureConfig.silent) {
      console.warn("[@inariwatch/capture/replay] rrweb.record not found in installed rrweb module.")
    }
    return
  }

  const sessionId = generateSessionId()
  currentSessionId = sessionId
  const now = Date.now()
  state = {
    sessionId,
    projectId: captureConfig.projectId,
    endpoint: getEndpoint(captureConfig, replayConfig),
    blockIndex: 0,
    buffer: [],
    bufferBytes: 0,
    blockStartMs: now,
    sessionStartMs: now,
    timer: null,
    debug: !!captureConfig.debug,
  }

  // Expose session id for other SDK layers (error capture attaches it).
  ;(window as unknown as { __INARIWATCH_SESSION__?: string }).__INARIWATCH_SESSION__ = sessionId
  patchFetch(sessionId)
  patchConsole()
  attachErrorHandlers()

  // PII classifier — run synchronously on every existing input BEFORE rrweb's
  // first full-snapshot fires, then keep watching via MutationObserver.
  // Heuristics are O(form-count), zero network. If `piiClassifier: "ai"`,
  // uncertain fields are batched to /api/replay/classify-pii in the background.
  const piiStrategy = replayConfig.piiClassifier ?? "ai"
  if (piiStrategy !== false) {
    applyPiiMasking(piiStrategy, state.endpoint, state.projectId, !!captureConfig.debug)
  }

  // When the classifier is enabled, default maskAllInputs to false so non-PII
  // fields (search boxes, comments) stay readable in the replay. Explicit
  // config always wins.
  const defaultMaskAll = piiStrategy === false ? true : false
  const maskAllResolved = replayConfig.maskAllInputs ?? defaultMaskAll

  record({
    maskAllInputs: maskAllResolved,
    maskInputOptions: { password: true, email: true },
    maskTextSelector: replayConfig.redactSelectors?.join(", ") || undefined,
    blockClass: "iw-block",
    ignoreClass: "iw-ignore",
    maskTextClass: "iw-mask",
    // rrweb v2: `maskInputClass` masks INPUT VALUES by CSS class. Aligning it
    // with `maskTextClass` means the classifier just needs to add `iw-mask`
    // to the element — both text and input values get masked.
    maskInputClass: "iw-mask",
    emit(event: unknown) {
      if (!state) return
      state.buffer.push(event)
      // Cheap approximation of byte size — JSON.stringify on every event is
      // expensive. Use a running sum of a per-event estimate.
      state.bufferBytes += estimateSize(event)
      if (state.bufferBytes >= maxBufferBytes || state.buffer.length >= MAX_EVENTS_PER_BLOCK) {
        void flushBlock()
      }
    },
  })

  state.timer = setInterval(() => void flushBlock(), blockDurationSec * 1000)

  // Flush on unload — best-effort via sendBeacon
  const finalFlush = () => void flushBlock({ isFinal: true })
  window.addEventListener("pagehide", finalFlush)
  window.addEventListener("beforeunload", finalFlush)

  replayActive = true
  if (captureConfig.debug && !captureConfig.silent) {
    console.warn(`[@inariwatch/capture/replay] active (session=${sessionId}, block=${blockDurationSec}s)`)
  }
}

function estimateSize(event: unknown): number {
  // Skip full JSON.stringify on every event. Estimate from a shallow inspection:
  // most rrweb events are 200-2000 bytes; mutations can be bigger but are rare.
  // If the event has a data.source of 3 (mutation), lean high.
  if (event && typeof event === "object") {
    const e = event as { type?: number; data?: { source?: number; attributes?: unknown[]; texts?: unknown[]; adds?: unknown[]; removes?: unknown[] } }
    if (e.type === 3 && e.data?.source === 0) {
      const counts =
        (e.data.attributes?.length ?? 0) +
        (e.data.texts?.length ?? 0) +
        (e.data.adds?.length ?? 0) +
        (e.data.removes?.length ?? 0)
      return Math.max(800, counts * 200)
    }
  }
  return 400
}

// ── PII classifier integration ───────────────────────────────────────────────

const MASK_CLASS = "iw-mask"
const AI_DEBOUNCE_MS = 500
const AI_MAX_BATCH = 20
/** LRU cache of server-AI classifications so we don't re-query identical fields. */
const aiCache = new Map<string, Classification>()
/** Queue of pending fields + their DOM nodes awaiting AI classification. */
let aiQueue: { hash: string; features: FieldFeatures; node: Element }[] = []
let aiFlushTimer: ReturnType<typeof setTimeout> | null = null

function extractFieldFeatures(el: Element): FieldFeatures {
  const tagName = el.tagName.toLowerCase()
  const attrs = el as unknown as { type?: string; name?: string; id?: string; placeholder?: string; autocomplete?: string }
  let labelText = ""
  // 1. aria-labelledby
  const labelledBy = el.getAttribute("aria-labelledby")
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy)
    if (labelEl) labelText = (labelEl.textContent ?? "").trim().slice(0, 200)
  }
  // 2. <label for="id">
  if (!labelText && el.id) {
    try {
      const labelEl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
      if (labelEl) labelText = (labelEl.textContent ?? "").trim().slice(0, 200)
    } catch {
      // CSS.escape fails on weird ids — skip
    }
  }
  // 3. Enclosing <label>
  if (!labelText) {
    const closest = (el as Element).closest?.("label")
    if (closest) labelText = (closest.textContent ?? "").trim().slice(0, 200)
  }
  return {
    tagName,
    inputType: attrs.type,
    name: attrs.name,
    id: attrs.id,
    placeholder: attrs.placeholder,
    ariaLabel: el.getAttribute("aria-label") ?? undefined,
    labelText,
    autocomplete: attrs.autocomplete,
  }
}

function applyMaskClass(node: Element): void {
  if (!node.classList.contains(MASK_CLASS)) node.classList.add(MASK_CLASS)
}

function removeMaskClass(node: Element): void {
  if (node.classList.contains(MASK_CLASS)) node.classList.remove(MASK_CLASS)
}

/**
 * Track nodes we masked *provisionally* while waiting for the AI classifier.
 * Only these nodes are eligible to be unmasked when the AI says `not_pii`.
 * A field the user already marked via any means (heuristic hit, manual class,
 * server cache) is NOT in this set and stays masked forever.
 */
const provisionallyMasked = new WeakSet<Element>()

function classifyAndMark(node: Element, strategy: "ai" | "heuristic"): Classification {
  const features = extractFieldFeatures(node)
  const hash = hashFeatures(features)

  // 1. Cache hit from a previous AI call — apply or unmask based on result.
  //    If the cached result is `not_pii`, we still leave alone any pre-existing
  //    mask class the user may have applied manually (never remove external).
  const cached = aiCache.get(hash)
  if (cached) {
    if (shouldMask(cached)) applyMaskClass(node)
    return cached
  }

  // 2. Heuristic classification
  const heuristic = classifyField(features)
  if (shouldMask(heuristic)) {
    applyMaskClass(node)
    return heuristic
  }

  // 3. Uncertain + AI enabled → FAIL CLOSED: mask now, queue for classification,
  //    and only un-mask if the server confirms `not_pii`. This closes the race
  //    where a user types into a just-added input during the ~500ms AI window.
  if (strategy === "ai" && isUncertain(heuristic)) {
    if (!node.classList.contains(MASK_CLASS)) {
      applyMaskClass(node)
      provisionallyMasked.add(node)
    }
    aiQueue.push({ hash, features, node })
    scheduleAiFlush()
  }

  return heuristic
}

function scheduleAiFlush(): void {
  if (aiFlushTimer) return
  aiFlushTimer = setTimeout(() => {
    aiFlushTimer = null
    void flushAiQueue()
  }, AI_DEBOUNCE_MS)
}

async function flushAiQueue(): Promise<void> {
  if (!state || aiQueue.length === 0) return
  const batch = aiQueue.splice(0, AI_MAX_BATCH)
  try {
    const resp = await fetch(`${state.endpoint}/api/replay/classify-pii`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: state.projectId,
        fields: batch.map((b) => ({ hash: b.hash, features: b.features })),
      }),
    })
    if (!resp.ok) return
    const data = (await resp.json()) as { results?: { hash: string; category: PiiCategory; confidence: number; reason: string }[] }
    const results = data.results ?? []
    for (const r of results) {
      const classification: Classification = { category: r.category, confidence: r.confidence, reason: r.reason }
      aiCache.set(r.hash, classification)
      const entry = batch.find((b) => b.hash === r.hash)
      if (!entry) continue
      if (shouldMask(classification)) {
        applyMaskClass(entry.node)
      } else if (r.category === "not_pii" && provisionallyMasked.has(entry.node)) {
        // Only un-mask nodes we provisionally masked ourselves — never remove
        // a class the user applied manually or a heuristic-confirmed mask.
        removeMaskClass(entry.node)
        provisionallyMasked.delete(entry.node)
      }
      // `uncertain` from AI → leave the provisional mask in place. Fail-closed.
    }
  } catch (err) {
    if (state?.debug) {
      console.warn("[@inariwatch/capture/replay] classify-pii failed:", err instanceof Error ? err.message : err)
    }
  }

  // Anything still queued (batch overflow) — schedule another flush
  if (aiQueue.length > 0) scheduleAiFlush()
}

function walkInputs(root: ParentNode): Element[] {
  try {
    return Array.from(root.querySelectorAll<HTMLElement>("input, textarea, select"))
  } catch {
    return []
  }
}

function applyPiiMasking(
  strategy: "ai" | "heuristic",
  _endpoint: string,
  _projectId: string,
  debug: boolean,
): void {
  if (typeof document === "undefined") return

  // 1. Classify every existing input before rrweb snapshots the DOM
  for (const node of walkInputs(document)) {
    try {
      classifyAndMark(node, strategy)
    } catch (err) {
      if (debug) console.warn("[@inariwatch/capture/replay] classify error:", err instanceof Error ? err.message : err)
    }
  }

  // 2. Watch the DOM for new inputs. Classify them synchronously — the
  //    mutation fires before the user can interact with the element, so
  //    rrweb captures the masked class on the next incremental snapshot.
  try {
    const observer = new MutationObserver((records) => {
      for (const rec of records) {
        for (const added of rec.addedNodes) {
          if (!(added instanceof Element)) continue
          // Classify the node itself if it's an input, plus any descendants
          if (added.matches("input, textarea, select")) {
            classifyAndMark(added, strategy)
          }
          for (const node of walkInputs(added)) {
            classifyAndMark(node, strategy)
          }
        }
      }
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })
  } catch (err) {
    if (debug) console.warn("[@inariwatch/capture/replay] MutationObserver failed:", err instanceof Error ? err.message : err)
  }
}

/** For tests: reset module state. Not exported from index.ts. */
export function __resetForTests(): void {
  replayActive = false
  currentSessionId = null
  if (state?.timer) clearInterval(state.timer)
  state = null
  aiCache.clear()
  aiQueue = []
  if (aiFlushTimer) clearTimeout(aiFlushTimer)
  aiFlushTimer = null
}

/** Expose estimator for unit tests. */
export { estimateSize as __estimateSize }
