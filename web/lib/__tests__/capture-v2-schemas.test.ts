/**
 * Tests for web/lib/capture-v2/schemas.ts type guards.
 * Spec: CAPTURE_V2_IMPLEMENTATION.md §3.3 + Q5.1.
 *
 * Validators are best-effort and never hard-block ingest. extractV2Fields()
 * silently drops malformed fields and returns whatever was valid.
 */

import { describe, it, expect } from "vitest"
import {
  extractV2Fields,
  isHypothesis,
  isPrecursor,
  isRuntimeSnap,
  isFleetMatch,
  isEapSignatures,
  isSerializedValue,
  isSourceContextFrame,
  isCausalGraph,
  isIntentContract,
  isForensicsCapture,
} from "@/lib/capture-v2/schemas"

describe("isSerializedValue", () => {
  it("accepts primitives", () => {
    expect(isSerializedValue({ type: "primitive", value: "x" })).toBe(true)
    expect(isSerializedValue({ type: "primitive", value: 1 })).toBe(true)
    expect(isSerializedValue({ type: "primitive", value: false })).toBe(true)
    expect(isSerializedValue({ type: "primitive", value: null })).toBe(true)
  })
  it("accepts object preview", () => {
    expect(isSerializedValue({ type: "object", preview: "[Object]", truncated: true })).toBe(true)
  })
  it("accepts redacted with valid reason", () => {
    expect(isSerializedValue({ type: "redacted", reason: "pii" })).toBe(true)
    expect(isSerializedValue({ type: "redacted", reason: "secret" })).toBe(true)
    expect(isSerializedValue({ type: "redacted", reason: "size" })).toBe(true)
    expect(isSerializedValue({ type: "redacted", reason: "other" })).toBe(false)
  })
  it("rejects junk", () => {
    expect(isSerializedValue(null)).toBe(false)
    expect(isSerializedValue("string")).toBe(false)
    expect(isSerializedValue({ type: "unknown" })).toBe(false)
  })
})

describe("isHypothesis", () => {
  it("accepts a well-formed hypothesis", () => {
    expect(
      isHypothesis({
        text: "x",
        prior: 0.7,
        cites: ["evidence.stack.0"],
        confidence: 0.8,
        source: "local_agent",
      }),
    ).toBe(true)
  })
  it("rejects out-of-range prior/confidence", () => {
    expect(isHypothesis({ text: "x", prior: 1.5, cites: [], confidence: 0.5, source: "local_agent" })).toBe(false)
    expect(isHypothesis({ text: "x", prior: 0.5, cites: [], confidence: -0.1, source: "local_agent" })).toBe(false)
  })
  it("rejects unknown source", () => {
    expect(isHypothesis({ text: "x", prior: 0.5, cites: [], confidence: 0.5, source: "openai" })).toBe(false)
  })
})

describe("isPrecursor", () => {
  it("accepts valid signal", () => {
    expect(isPrecursor({ signal: "eventloop_p99", deltaPct: 50, windowSeconds: 60 })).toBe(true)
    expect(isPrecursor({ signal: "rss_trend", deltaPct: -10, windowSeconds: 60 })).toBe(true)
  })
  it("rejects unknown signal", () => {
    expect(isPrecursor({ signal: "made_up", deltaPct: 0, windowSeconds: 60 })).toBe(false)
  })
})

describe("isRuntimeSnap", () => {
  it("accepts all-numeric snap", () => {
    expect(isRuntimeSnap({ heapMb: 1, rssMb: 2, eventloopP99Ms: 3, openHandles: 4 })).toBe(true)
  })
  it("rejects when missing field", () => {
    expect(isRuntimeSnap({ heapMb: 1, rssMb: 2, eventloopP99Ms: 3 })).toBe(false)
  })
  it("rejects NaN", () => {
    expect(isRuntimeSnap({ heapMb: NaN, rssMb: 2, eventloopP99Ms: 3, openHandles: 4 })).toBe(false)
  })
})

describe("isFleetMatch", () => {
  it("accepts minimal", () => {
    expect(isFleetMatch({ bloomHit: false })).toBe(true)
  })
  it("accepts full", () => {
    expect(isFleetMatch({ bloomHit: true, communityFixId: "fix-123", teamsHit: 47 })).toBe(true)
  })
  it("rejects when bloomHit not bool", () => {
    expect(isFleetMatch({ bloomHit: "yes" })).toBe(false)
  })
})

describe("isEapSignatures", () => {
  it("accepts minimal", () => {
    expect(
      isEapSignatures({
        evidenceMerkleRoot: "abcd",
        evidenceSignature: "sig",
        signerPubkey: "pub",
        signedAt: "2026-04-24T00:00:00.000Z",
      }),
    ).toBe(true)
  })
  it("rejects when missing field", () => {
    expect(
      isEapSignatures({
        evidenceMerkleRoot: "abcd",
        evidenceSignature: "sig",
        signedAt: "2026-04-24T00:00:00.000Z",
      }),
    ).toBe(false)
  })
})

describe("isSourceContextFrame, isCausalGraph, isIntentContract, isForensicsCapture", () => {
  it("isSourceContextFrame", () => {
    expect(isSourceContextFrame({ frameIndex: 0, before: ["a"], line: "x", after: ["b"] })).toBe(true)
    expect(isSourceContextFrame({ frameIndex: 0, before: "wrong", line: "x", after: [] })).toBe(false)
  })
  it("isCausalGraph", () => {
    expect(isCausalGraph({ nodes: [], edges: [] })).toBe(true)
    expect(isCausalGraph({ nodes: [], edges: "wrong" })).toBe(false)
  })
  it("isIntentContract", () => {
    expect(isIntentContract({ source: "ts", path: "Foo", shape: {} })).toBe(true)
    expect(isIntentContract({ source: "made_up", path: "Foo", shape: {} })).toBe(false)
  })
  it("isForensicsCapture accepts empty/partial", () => {
    expect(isForensicsCapture({})).toBe(true)
    expect(isForensicsCapture({ asyncStack: ["a", "b"] })).toBe(true)
    expect(isForensicsCapture({ asyncStack: "wrong" })).toBe(false)
  })
})

describe("extractV2Fields", () => {
  it("returns empty for non-object input", () => {
    expect(extractV2Fields(null)).toEqual({})
    expect(extractV2Fields("string")).toEqual({})
    expect(extractV2Fields(42)).toEqual({})
  })

  it("extracts a fully-populated payload", () => {
    const cd = {
      schemaVersion: "2.0",
      runtimeSnap: { heapMb: 100, rssMb: 200, eventloopP99Ms: 5, openHandles: 10 },
      precursors: [{ signal: "eventloop_p99", deltaPct: 30, windowSeconds: 60 }],
      hypotheses: [
        { text: "race", prior: 0.7, cites: [], confidence: 0.6, source: "local_agent" },
      ],
      fleetMatch: { bloomHit: true, communityFixId: "fix-1", teamsHit: 5 },
      sourceContext: [{ frameIndex: 0, before: ["a"], line: "x", after: ["b"] }],
      causalGraph: { nodes: [], edges: [] },
      expected: { contracts: [{ source: "ts", path: "Foo", shape: {} }] },
      eapSignatures: {
        evidenceMerkleRoot: "root",
        evidenceSignature: "sig",
        signerPubkey: "pub",
        signedAt: "2026-04-24T00:00:00.000Z",
      },
      tokensEstimated: 1024,
    }
    const out = extractV2Fields(cd)
    expect(out.schemaVersion).toBe("2.0")
    expect(out.runtimeSnap?.heapMb).toBe(100)
    expect(out.precursors).toHaveLength(1)
    expect(out.hypotheses).toHaveLength(1)
    expect(out.fleetMatch?.bloomHit).toBe(true)
    expect(out.sourceContext).toHaveLength(1)
    expect(out.causalGraph?.nodes).toEqual([])
    expect(out.expected?.contracts).toHaveLength(1)
    expect(out.eapSignatures?.evidenceMerkleRoot).toBe("root")
    expect(out.tokensEstimated).toBe(1024)
  })

  it("silently drops malformed fields, keeps valid ones", () => {
    const cd = {
      runtimeSnap: { heapMb: "not a number" }, // invalid → dropped
      hypotheses: [
        { text: "valid", prior: 0.5, cites: [], confidence: 0.5, source: "heuristic" },
        { text: "invalid", prior: 99, cites: [], confidence: 0.5, source: "heuristic" }, // dropped
      ],
      precursors: [
        { signal: "eventloop_p99", deltaPct: 10, windowSeconds: 60 },
        { signal: "fake_signal", deltaPct: 10, windowSeconds: 60 }, // dropped
      ],
    }
    const out = extractV2Fields(cd)
    expect(out.runtimeSnap).toBeUndefined()
    expect(out.hypotheses).toHaveLength(1)
    expect(out.precursors).toHaveLength(1)
  })

  it("ignores entirely unknown fields without throwing", () => {
    const cd = { totallyUnknown: { nested: "stuff" }, schemaVersion: "2.0" }
    const out = extractV2Fields(cd)
    expect(out.schemaVersion).toBe("2.0")
    expect(Object.keys(out)).toEqual(["schemaVersion"])
  })

  it("does not extract schemaVersion when not exactly '2.0'", () => {
    expect(extractV2Fields({ schemaVersion: "1.0" }).schemaVersion).toBeUndefined()
    expect(extractV2Fields({ schemaVersion: "2.1" }).schemaVersion).toBeUndefined()
  })
})
