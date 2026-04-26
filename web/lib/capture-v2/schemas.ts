/**
 * Payload v2 type guards.
 *
 * Spec: CAPTURE_V2_IMPLEMENTATION.md §3.3
 *
 * Hand-rolled (no Zod dep) — these are validator-only. The webhook ingest
 * never rejects an event because a guard returned false; it only logs a
 * `payload_v2_shape_warning` metric and degrades gracefully.
 *
 * Consumers:
 *   - AI formatters (web/lib/ai/capture-context.ts) for type-safe access
 *   - Test fixtures (capture/__tests__/v2-budget.test.ts)
 *   - Future: /api/dev/payload-validator debug route
 *
 * Mirrors the SDK types in capture/src/types.ts. Keep in sync.
 */

export interface SerializedValuePrimitive {
  type: "primitive"
  value: string | number | boolean | null
}
export interface SerializedValueObject {
  type: "object"
  preview: string
  truncated: boolean
}
export interface SerializedValueRedacted {
  type: "redacted"
  reason: "pii" | "size" | "secret"
}
export type SerializedValue = SerializedValuePrimitive | SerializedValueObject | SerializedValueRedacted

export interface ForensicsCapture {
  locals?: Record<string, Record<string, SerializedValue>>
  closureChains?: Record<string, Record<string, SerializedValue>>
  asyncStack?: string[]
}

export interface SourceContextFrame {
  frameIndex: number
  before: string[]
  line: string
  after: string[]
  blame?: { commit: string; author: string; date: string; message: string }
}

export interface RuntimeSnap {
  heapMb: number
  rssMb: number
  eventloopP99Ms: number
  openHandles: number
}

export type PrecursorSignal =
  | "eventloop_p99"
  | "rss_trend"
  | "retry_burst"
  | "circuit_breaker_trip"
  | "near_miss_rejection"

export interface Precursor {
  signal: PrecursorSignal
  deltaPct: number
  windowSeconds: number
}

export interface Hypothesis {
  text: string
  prior: number
  cites: string[]
  confidence: number
  source: "local_agent" | "bloom_match" | "heuristic"
}

export interface FleetMatch {
  bloomHit: boolean
  communityFixId?: string
  teamsHit?: number
}

export interface IntentContract {
  source: "ts" | "zod" | "drizzle" | "openapi" | "prisma" | "graphql" | "pydantic" | "java" | "rust"
  path: string
  shape: unknown
}

export interface CausalGraph {
  nodes: Array<{ id: string; kind: "io" | "fn" | "promise" | "syscall"; label: string }>
  edges: Array<{ from: string; to: string; kind: "causal" | "temporal" | "data" }>
}

export interface EapSignatures {
  evidenceMerkleRoot: string
  evidenceSignature: string
  signerPubkey: string
  signedAt: string
  receiptId?: string
}

/** Shape of v2 fields once unpacked from `alert.correlationData`. */
export interface CaptureV2Fields {
  schemaVersion?: "2.0"
  forensics?: ForensicsCapture
  sourceContext?: SourceContextFrame[]
  runtimeSnap?: RuntimeSnap
  precursors?: Precursor[]
  hypotheses?: Hypothesis[]
  fleetMatch?: FleetMatch
  expected?: { contracts: IntentContract[] }
  causalGraph?: CausalGraph
  eapSignatures?: EapSignatures
  tokensEstimated?: number
}

// ─── Type guards ──────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const isStr = (v: unknown): v is string => typeof v === "string"
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const isBool = (v: unknown): v is boolean => typeof v === "boolean"
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr)

export function isSerializedValue(v: unknown): v is SerializedValue {
  if (!isObj(v)) return false
  const t = v.type
  if (t === "primitive") {
    return v.value === null || isStr(v.value) || isNum(v.value) || isBool(v.value)
  }
  if (t === "object") return isStr(v.preview) && isBool(v.truncated)
  if (t === "redacted") return v.reason === "pii" || v.reason === "size" || v.reason === "secret"
  return false
}

export function isForensicsCapture(v: unknown): v is ForensicsCapture {
  if (!isObj(v)) return false
  if (v.asyncStack !== undefined && !isStrArr(v.asyncStack)) return false
  if (v.locals !== undefined && !isObj(v.locals)) return false
  if (v.closureChains !== undefined && !isObj(v.closureChains)) return false
  return true
}

export function isSourceContextFrame(v: unknown): v is SourceContextFrame {
  if (!isObj(v)) return false
  return isNum(v.frameIndex) && isStrArr(v.before) && isStr(v.line) && isStrArr(v.after)
}

export function isRuntimeSnap(v: unknown): v is RuntimeSnap {
  if (!isObj(v)) return false
  return isNum(v.heapMb) && isNum(v.rssMb) && isNum(v.eventloopP99Ms) && isNum(v.openHandles)
}

const PRECURSOR_SIGNALS = new Set<PrecursorSignal>([
  "eventloop_p99",
  "rss_trend",
  "retry_burst",
  "circuit_breaker_trip",
  "near_miss_rejection",
])

export function isPrecursor(v: unknown): v is Precursor {
  if (!isObj(v)) return false
  return PRECURSOR_SIGNALS.has(v.signal as PrecursorSignal) && isNum(v.deltaPct) && isNum(v.windowSeconds)
}

const HYPOTHESIS_SOURCES = new Set(["local_agent", "bloom_match", "heuristic"])

export function isHypothesis(v: unknown): v is Hypothesis {
  if (!isObj(v)) return false
  return (
    isStr(v.text) &&
    isNum(v.prior) && v.prior >= 0 && v.prior <= 1 &&
    isStrArr(v.cites) &&
    isNum(v.confidence) && v.confidence >= 0 && v.confidence <= 1 &&
    HYPOTHESIS_SOURCES.has(v.source as string)
  )
}

export function isFleetMatch(v: unknown): v is FleetMatch {
  if (!isObj(v)) return false
  if (!isBool(v.bloomHit)) return false
  if (v.communityFixId !== undefined && !isStr(v.communityFixId)) return false
  if (v.teamsHit !== undefined && !isNum(v.teamsHit)) return false
  return true
}

const INTENT_SOURCES = new Set(["ts", "zod", "drizzle", "openapi", "prisma", "graphql", "pydantic", "java", "rust"])

export function isIntentContract(v: unknown): v is IntentContract {
  if (!isObj(v)) return false
  return INTENT_SOURCES.has(v.source as string) && isStr(v.path)
}

export function isCausalGraph(v: unknown): v is CausalGraph {
  if (!isObj(v)) return false
  return Array.isArray(v.nodes) && Array.isArray(v.edges)
}

export function isEapSignatures(v: unknown): v is EapSignatures {
  if (!isObj(v)) return false
  return (
    isStr(v.evidenceMerkleRoot) &&
    isStr(v.evidenceSignature) &&
    isStr(v.signerPubkey) &&
    isStr(v.signedAt)
  )
}

/**
 * Best-effort extraction of v2 fields from `alert.correlationData`.
 * Returns a partial shape — every field validated independently.
 * Invalid fields are silently dropped (degrade-gracefully policy).
 */
export function extractV2Fields(correlationData: unknown): CaptureV2Fields {
  if (!isObj(correlationData)) return {}
  const out: CaptureV2Fields = {}

  if (correlationData.schemaVersion === "2.0") out.schemaVersion = "2.0"
  if (isForensicsCapture(correlationData.forensics)) out.forensics = correlationData.forensics
  if (Array.isArray(correlationData.sourceContext)) {
    const frames = correlationData.sourceContext.filter(isSourceContextFrame)
    if (frames.length) out.sourceContext = frames
  }
  if (isRuntimeSnap(correlationData.runtimeSnap)) out.runtimeSnap = correlationData.runtimeSnap
  if (Array.isArray(correlationData.precursors)) {
    const ps = correlationData.precursors.filter(isPrecursor)
    if (ps.length) out.precursors = ps
  }
  if (Array.isArray(correlationData.hypotheses)) {
    const hs = correlationData.hypotheses.filter(isHypothesis)
    if (hs.length) out.hypotheses = hs
  }
  if (isFleetMatch(correlationData.fleetMatch)) out.fleetMatch = correlationData.fleetMatch
  if (
    isObj(correlationData.expected) &&
    Array.isArray((correlationData.expected as Record<string, unknown>).contracts)
  ) {
    const contracts = (correlationData.expected as { contracts: unknown[] }).contracts.filter(isIntentContract)
    if (contracts.length) out.expected = { contracts }
  }
  if (isCausalGraph(correlationData.causalGraph)) out.causalGraph = correlationData.causalGraph
  if (isEapSignatures(correlationData.eapSignatures)) out.eapSignatures = correlationData.eapSignatures
  if (isNum(correlationData.tokensEstimated)) out.tokensEstimated = correlationData.tokensEstimated

  return out
}
