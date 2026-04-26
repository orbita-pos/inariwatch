/**
 * Capture webhook → correlationData assembler.
 *
 * Pulled out of the route handler so the v1/v2 mapping can be unit-tested
 * without standing up Next + DB + rate limiting. The route just calls this
 * with the parsed JSON body and assigns the result to `createAlertIfNew`.
 *
 * Spec: CAPTURE_V2_IMPLEMENTATION.md §3.2
 *
 * Contract:
 *   - v1 events (no v2 fields present) produce a correlationData object
 *     byte-identical to what the pre-v2 route assembled (Q5.1 acceptance).
 *   - v2 fields are added additively when present.
 *   - `forensics` is dropped if it serializes to >100KB (runaway protection).
 */

export function assembleCorrelationData(
  event: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const correlationData: Record<string, unknown> = {}

  // v1 fields (do not change ordering — alert.correlationData JSON shape is
  // observable by downstream consumers and snapshot tests).
  if (event.git) correlationData.git = event.git
  if (event.breadcrumbs) correlationData.breadcrumbs = event.breadcrumbs
  if (event.env) correlationData.env = event.env
  if (event.user) correlationData.user = event.user
  if (event.tags) correlationData.tags = event.tags
  if (event.request) correlationData.request = event.request
  const ctx = event.context as Record<string, unknown> | undefined
  if (ctx?.securityContext) correlationData.securityContext = ctx.securityContext

  // Payload v2 (additive). Server treats unknown v2 fields as opaque.
  // v2 wire format uses snake_case at the boundary (`schema_version`).
  // The legacy in-memory shape used camelCase (`schemaVersion`).
  // Both flag the event as v2; we normalize to camelCase in correlationData
  // so dashboard/MCP/Slack consumers don't need to care which side spoke.
  if (event.schemaVersion === "2.0" || event.schema_version === "2.0") {
    correlationData.schemaVersion = "2.0"
  }
  // v2 wire-format fields (snake_case). Carried verbatim for downstream
  // AI consumers — they read `evidence`, `hypotheses`, `signature` and
  // expect the canonical SKYNET §12 shape.
  if (event.evidence) correlationData.evidence = event.evidence
  if (event.signature) correlationData.signature = event.signature
  if (event.graph) correlationData.graph = event.graph
  if (event.embedding_v1) correlationData.embeddingV1 = event.embedding_v1
  if (event.fleet_match) correlationData.fleetMatch = event.fleet_match

  if (event.forensics) {
    let forensicsBytes = 0
    try {
      forensicsBytes = JSON.stringify(event.forensics).length
    } catch {
      forensicsBytes = Number.MAX_SAFE_INTEGER
    }
    if (forensicsBytes <= 100_000) correlationData.forensics = event.forensics
  }
  if (event.sourceContext) correlationData.sourceContext = event.sourceContext
  if (event.runtimeSnap) correlationData.runtimeSnap = event.runtimeSnap
  if (event.precursors) correlationData.precursors = event.precursors
  if (event.hypotheses) correlationData.hypotheses = event.hypotheses
  if (event.fleetMatch) correlationData.fleetMatch = event.fleetMatch
  if (event.expected) correlationData.expected = event.expected
  if (event.causalGraph) correlationData.causalGraph = event.causalGraph
  if (event.eapSignatures) correlationData.eapSignatures = event.eapSignatures
  if (typeof event.tokensEstimated === "number") {
    correlationData.tokensEstimated = event.tokensEstimated
  }

  return Object.keys(correlationData).length > 0 ? correlationData : undefined
}
