/**
 * Tests for @inariwatch/capture v2 token budget enforcement.
 * Spec: CAPTURE_V2_IMPLEMENTATION.md §3.1 + Q5.1 acceptance.
 *
 * What we assert:
 *   - Under-budget events are unchanged (only tokensEstimated populated)
 *   - Over-budget drops follow the documented priority order
 *   - v1 fields (title, body, fingerprint) are NEVER touched
 *   - Drop summary surfaces every dropped field for telemetry
 *   - Forensics container is removed when both children are gone
 */

import { describe, it, expect } from "vitest"
// Import directly from the local SDK source — same pattern as
// network-body-masker.test.ts. Avoids relying on the published npm version
// (which lags behind local v2 work) and avoids tsconfig path overrides
// that would also affect Next runtime resolution.
import {
  applyTokenBudget,
  estimateTokens,
  V2_FIELD_DROP_PRIORITY,
} from "../../../capture/src/v2-budget"
import type { ErrorEvent, Hypothesis } from "../../../capture/src/types"

const baseEvent = (): ErrorEvent => ({
  fingerprint: "fp-test-1",
  title: "TestError: boom",
  body: "stack trace here",
  severity: "critical",
  timestamp: "2026-04-24T00:00:00.000Z",
  schemaVersion: "2.0",
})

describe("estimateTokens", () => {
  it("returns 0 for null/undefined", () => {
    expect(estimateTokens(null)).toBe(0)
    expect(estimateTokens(undefined)).toBe(0)
  })

  it("ceil(bytes / 4) for plain strings", () => {
    // "hello" → 7 bytes (with quotes) → ceil(7/4) = 2
    expect(estimateTokens("hello")).toBe(2)
  })

  it("counts JSON.stringify length for objects", () => {
    const v = { a: 1, b: "two" }
    const expected = Math.ceil(JSON.stringify(v).length / 4)
    expect(estimateTokens(v)).toBe(expected)
  })
})

describe("applyTokenBudget — under budget", () => {
  it("does not drop when event fits", () => {
    const e = baseEvent()
    e.runtimeSnap = { heapMb: 1, rssMb: 2, eventloopP99Ms: 3, openHandles: 4 }
    const result = applyTokenBudget(e, 8000)
    expect(result.dropped).toBe(false)
    expect(result.droppedFields).toEqual([])
    expect(e.runtimeSnap).toBeDefined()
    // applyTokenBudget never auto-writes tokensEstimated; caller may attach
    // it from result.finalTokens if desired.
    expect(result.finalTokens).toBe(estimateTokens(e))
  })
})

describe("applyTokenBudget — drop priority", () => {
  /** Helper to build a maximally-loaded v2 event. */
  function loadedEvent(): ErrorEvent {
    const e = baseEvent()
    const fillerFrames = Array.from({ length: 5 }, (_, i) => ({
      frameIndex: i,
      before: Array(10).fill("// before line filler ".repeat(20)),
      line: "// the failing line filler ".repeat(20),
      after: Array(10).fill("// after line filler ".repeat(20)),
    }))
    e.sourceContext = fillerFrames
    e.causalGraph = {
      nodes: Array.from({ length: 50 }, (_, i) => ({
        id: `n${i}`,
        kind: "fn" as const,
        label: `nodeLabel${i}`.repeat(10),
      })),
      edges: Array.from({ length: 60 }, (_, i) => ({
        from: `n${i % 50}`,
        to: `n${(i + 1) % 50}`,
        kind: "causal" as const,
      })),
    }
    e.expected = {
      contracts: Array.from({ length: 20 }, (_, i) => ({
        source: "ts" as const,
        path: `Type${i}`,
        shape: { fields: Array(20).fill({ name: "filler", type: "string" }) },
      })),
    }
    e.precursors = Array.from({ length: 8 }, (_, i) => ({
      signal: "eventloop_p99" as const,
      deltaPct: i * 5,
      windowSeconds: 60,
    }))
    e.breadcrumbs = Array.from({ length: 30 }, (_, i) => ({
      timestamp: "2026-04-24T00:00:00.000Z",
      category: "console" as const,
      message: `breadcrumb ${i} `.repeat(15),
      level: "info" as const,
    }))
    e.forensics = {
      locals: {
        "0": { user: { type: "primitive", value: "alice".repeat(50) } },
        "1": { ctx: { type: "primitive", value: "ctx-data".repeat(50) } },
        "2": { tmp: { type: "primitive", value: "tmp-val".repeat(50) } },
      },
      closureChains: {
        "0": { outer: { type: "primitive", value: "closure".repeat(50) } },
      },
    }
    e.runtimeSnap = { heapMb: 100, rssMb: 200, eventloopP99Ms: 50, openHandles: 25 }
    e.hypotheses = [
      { text: "race condition on user lookup", prior: 0.7, cites: ["evidence.stack.0"], confidence: 0.6, source: "local_agent" },
    ]
    return e
  }

  it("drops causalGraph first when over budget", () => {
    const e = loadedEvent()
    const result = applyTokenBudget(e, 2000)
    expect(result.droppedFields[0]).toBe("causalGraph")
    expect(e.causalGraph).toBeUndefined()
  })

  it("drops in documented priority order", () => {
    const e = loadedEvent()
    const result = applyTokenBudget(e, 50) // tiny budget, force max drops

    // Each dropped field must appear in V2_FIELD_DROP_PRIORITY order (with the
    // forensics.locals[1..] sub-step inserted between locals and runtimeSnap).
    const indexOf = (field: string): number => {
      const idx = V2_FIELD_DROP_PRIORITY.findIndex((p) => field.startsWith(p))
      // forensics.locals[1..] is an internal sub-step under "forensics.locals"
      if (idx === -1 && field === "forensics.locals[1..]") {
        return V2_FIELD_DROP_PRIORITY.indexOf("forensics.locals")
      }
      return idx
    }
    let lastIdx = -1
    for (const dropped of result.droppedFields) {
      const i = indexOf(dropped)
      expect(i).toBeGreaterThanOrEqual(0)
      expect(i).toBeGreaterThanOrEqual(lastIdx)
      lastIdx = i
    }
  })

  it("never touches v1 fields", () => {
    const e = loadedEvent()
    const v1Snapshot = {
      fingerprint: e.fingerprint,
      title: e.title,
      body: e.body,
      severity: e.severity,
      timestamp: e.timestamp,
    }
    applyTokenBudget(e, 50)
    expect(e.fingerprint).toBe(v1Snapshot.fingerprint)
    expect(e.title).toBe(v1Snapshot.title)
    expect(e.body).toBe(v1Snapshot.body)
    expect(e.severity).toBe(v1Snapshot.severity)
    expect(e.timestamp).toBe(v1Snapshot.timestamp)
  })

  it("trims sourceContext.after but keeps before + line", () => {
    const e = baseEvent()
    e.sourceContext = [
      {
        frameIndex: 0,
        before: Array(20).fill("// before pad ".repeat(10)),
        line: "FAILING_LINE",
        after: Array(20).fill("// after pad ".repeat(10)),
      },
    ]
    // Budget tight enough that even after dropping causalGraph + expected
    // we still need sourceContext.after trimmed.
    const result = applyTokenBudget(e, 400)
    expect(result.droppedFields).toContain("sourceContext.after")
    if (e.sourceContext) {
      expect(e.sourceContext[0].after).toEqual([])
      expect(e.sourceContext[0].line).toBe("FAILING_LINE")
      expect(e.sourceContext[0].before.length).toBeGreaterThan(0)
    }
  })

  it("keeps top-3 precursors by absolute deltaPct", () => {
    const e = baseEvent()
    e.precursors = [
      { signal: "eventloop_p99", deltaPct: 10, windowSeconds: 60 },
      { signal: "eventloop_p99", deltaPct: -90, windowSeconds: 60 },
      { signal: "eventloop_p99", deltaPct: 50, windowSeconds: 60 },
      { signal: "eventloop_p99", deltaPct: 5, windowSeconds: 60 },
      { signal: "eventloop_p99", deltaPct: 80, windowSeconds: 60 },
    ]
    e.expected = { contracts: [{ source: "ts", path: "Big".repeat(2000), shape: {} }] }
    applyTokenBudget(e, 100)
    if (e.precursors) {
      expect(e.precursors).toHaveLength(3)
      const deltas = e.precursors.map((p) => Math.abs(p.deltaPct)).sort((a, b) => b - a)
      expect(deltas).toEqual([90, 80, 50])
    }
  })

  it("keeps last 15 breadcrumbs (most recent)", () => {
    const e = baseEvent()
    e.breadcrumbs = Array.from({ length: 30 }, (_, i) => ({
      timestamp: `2026-04-24T00:00:${String(i).padStart(2, "0")}.000Z`,
      category: "console" as const,
      message: `crumb-${i}`,
      level: "info" as const,
    }))
    e.expected = { contracts: [{ source: "ts", path: "Big".repeat(2000), shape: {} }] }
    applyTokenBudget(e, 100)
    if (e.breadcrumbs) {
      expect(e.breadcrumbs).toHaveLength(15)
      expect(e.breadcrumbs[0].message).toBe("crumb-15")
      expect(e.breadcrumbs[14].message).toBe("crumb-29")
    }
  })

  it("removes forensics container when locals + closures both gone", () => {
    const e = baseEvent()
    e.forensics = {
      locals: { "0": { x: { type: "primitive", value: "hello".repeat(200) } } },
      closureChains: { "0": { y: { type: "primitive", value: "world".repeat(200) } } },
    }
    e.expected = { contracts: [{ source: "ts", path: "Big".repeat(2000), shape: {} }] }
    applyTokenBudget(e, 50)
    expect(e.forensics).toBeUndefined()
  })

  it("hypotheses survive longest (most valuable per token)", () => {
    const e = baseEvent()
    const hypothesis: Hypothesis = {
      text: "x",
      prior: 0.5,
      cites: [],
      confidence: 0.5,
      source: "local_agent",
    }
    e.hypotheses = [hypothesis]
    e.causalGraph = {
      nodes: Array(100).fill({ id: "x", kind: "fn", label: "filler".repeat(20) }),
      edges: [],
    }
    e.expected = { contracts: Array(50).fill({ source: "ts", path: "T".repeat(100), shape: {} }) }
    applyTokenBudget(e, 200)
    expect(e.hypotheses).toBeDefined()
    expect(e.causalGraph).toBeUndefined()
    expect(e.expected).toBeUndefined()
  })
})

describe("applyTokenBudget — drop summary", () => {
  it("returns finalTokens equal to estimateTokens of mutated event", () => {
    const e: ErrorEvent = baseEvent()
    e.causalGraph = {
      nodes: Array(50).fill({ id: "n", kind: "fn", label: "x".repeat(20) }),
      edges: [],
    }
    const result = applyTokenBudget(e, 30)
    expect(result.finalTokens).toBe(estimateTokens(e))
  })

  it("dropped flag matches presence of droppedFields", () => {
    const small = baseEvent()
    expect(applyTokenBudget(small, 8000).dropped).toBe(false)

    const big = baseEvent()
    big.causalGraph = {
      nodes: Array(100).fill({ id: "n", kind: "fn", label: "x".repeat(50) }),
      edges: [],
    }
    const r = applyTokenBudget(big, 30)
    expect(r.dropped).toBe(true)
    expect(r.droppedFields.length).toBeGreaterThan(0)
  })
})
