/**
 * Tests for the capture webhook → correlationData assembler.
 * Spec: CAPTURE_V2_IMPLEMENTATION.md §3.2 + Q5.1 acceptance.
 *
 * Critical assertion: a v1-only event produces a correlationData object
 * BYTE-IDENTICAL to what the pre-v2 route assembled. This is the
 * "no regression for existing customers" guarantee.
 *
 * The reference snapshot below is the literal v1 assembler logic copied
 * inline so the comparison can never silently drift.
 */

import { describe, it, expect } from "vitest"
import { assembleCorrelationData } from "@/lib/webhooks/capture-correlation"

/** Reference: literal copy of the v1 assembler (pre-v2). */
function v1ReferenceAssembler(
  event: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const correlationData: Record<string, unknown> = {}
  if (event.git) correlationData.git = event.git
  if (event.breadcrumbs) correlationData.breadcrumbs = event.breadcrumbs
  if (event.env) correlationData.env = event.env
  if (event.user) correlationData.user = event.user
  if (event.tags) correlationData.tags = event.tags
  if (event.request) correlationData.request = event.request
  const ctx = event.context as Record<string, unknown> | undefined
  if (ctx?.securityContext) correlationData.securityContext = ctx.securityContext
  return Object.keys(correlationData).length > 0 ? correlationData : undefined
}

describe("assembleCorrelationData — v1 byte-identical regression", () => {
  it("produces undefined for empty events (matches v1)", () => {
    expect(assembleCorrelationData({})).toEqual(v1ReferenceAssembler({}))
  })

  it("matches v1 for a typical Next.js event with git+breadcrumbs+env+user", () => {
    const e = {
      title: "TypeError: undefined.foo",
      git: { commit: "abc123", branch: "main", message: "fix", timestamp: "t", dirty: false },
      breadcrumbs: [{ timestamp: "t", category: "console", message: "x", level: "info" }],
      env: { node: "v22", platform: "linux", arch: "x64", cpuCount: 4, totalMemoryMB: 1, freeMemoryMB: 1, heapUsedMB: 1, heapTotalMB: 1, uptime: 1 },
      user: { id: "u1", role: "admin" },
      request: { method: "POST", url: "/api/foo" },
      tags: { feature: "checkout" },
    }
    expect(JSON.stringify(assembleCorrelationData(e))).toBe(JSON.stringify(v1ReferenceAssembler(e)))
  })

  it("matches v1 when only context.securityContext is present", () => {
    const e = {
      context: {
        securityContext: {
          vulnerability: "sql_injection",
          sink: "pg.query",
          sinkModule: "pg",
          source: "req.query.q",
          taintedInput: "'; DROP --",
          sinkArgument: "SELECT *",
          blocked: true,
        },
      },
    }
    expect(JSON.stringify(assembleCorrelationData(e))).toBe(JSON.stringify(v1ReferenceAssembler(e)))
  })

  it("matches v1 for a kitchen-sink v1 event", () => {
    const e = {
      git: { commit: "a", branch: "b", message: "c", timestamp: "d", dirty: true },
      breadcrumbs: Array.from({ length: 30 }, (_, i) => ({
        timestamp: "t",
        category: "fetch",
        message: `b${i}`,
        level: "info",
      })),
      env: { node: "v22", platform: "linux", arch: "x64", cpuCount: 4, totalMemoryMB: 1, freeMemoryMB: 1, heapUsedMB: 1, heapTotalMB: 1, uptime: 1 },
      user: { id: "u1" },
      request: { method: "GET", url: "/api/items?x=1" },
      tags: { region: "iad1", canary: "true" },
      context: { securityContext: { vulnerability: "ssrf", sink: "fetch", sinkModule: "global", source: "req.body.url", taintedInput: "x", sinkArgument: "x", blocked: false } },
    }
    expect(JSON.stringify(assembleCorrelationData(e))).toBe(JSON.stringify(v1ReferenceAssembler(e)))
  })

  it("matches v1 for fully-empty context object", () => {
    const e = { context: {} }
    expect(assembleCorrelationData(e)).toEqual(v1ReferenceAssembler(e))
  })
})

describe("assembleCorrelationData — v2 additive", () => {
  it("preserves v1 fields when v2 fields are present", () => {
    const e = {
      git: { commit: "a", branch: "b", message: "c", timestamp: "d", dirty: false },
      schemaVersion: "2.0",
      runtimeSnap: { heapMb: 100, rssMb: 200, eventloopP99Ms: 5, openHandles: 10 },
    }
    const out = assembleCorrelationData(e)!
    expect(out.git).toEqual(e.git)
    expect(out.schemaVersion).toBe("2.0")
    expect(out.runtimeSnap).toEqual(e.runtimeSnap)
  })

  it("extracts each v2 field independently", () => {
    const e = {
      schemaVersion: "2.0",
      sourceContext: [{ frameIndex: 0, before: [], line: "x", after: [] }],
      precursors: [{ signal: "eventloop_p99", deltaPct: 30, windowSeconds: 60 }],
      hypotheses: [{ text: "x", prior: 0.5, cites: [], confidence: 0.5, source: "local_agent" }],
      fleetMatch: { bloomHit: true },
      expected: { contracts: [{ source: "ts", path: "Foo", shape: {} }] },
      causalGraph: { nodes: [], edges: [] },
      eapSignatures: { evidenceMerkleRoot: "r", evidenceSignature: "s", signerPubkey: "p", signedAt: "t" },
      tokensEstimated: 1024,
    }
    const out = assembleCorrelationData(e)!
    expect(out.sourceContext).toEqual(e.sourceContext)
    expect(out.precursors).toEqual(e.precursors)
    expect(out.hypotheses).toEqual(e.hypotheses)
    expect(out.fleetMatch).toEqual(e.fleetMatch)
    expect(out.expected).toEqual(e.expected)
    expect(out.causalGraph).toEqual(e.causalGraph)
    expect(out.eapSignatures).toEqual(e.eapSignatures)
    expect(out.tokensEstimated).toBe(1024)
  })

  it("ignores schemaVersion when not exactly '2.0'", () => {
    expect(assembleCorrelationData({ schemaVersion: "1.0" })).toBeUndefined()
    expect(assembleCorrelationData({ schemaVersion: "2.1" })).toBeUndefined()
  })

  it("drops forensics over 100KB", () => {
    const massive = {
      locals: {
        "0": Object.fromEntries(
          Array.from({ length: 10_000 }, (_, i) => [
            `var${i}`,
            { type: "primitive", value: "x".repeat(20) },
          ]),
        ),
      },
    }
    expect(JSON.stringify(massive).length).toBeGreaterThan(100_000)
    const out = assembleCorrelationData({ forensics: massive })
    expect(out).toBeUndefined()
  })

  it("keeps forensics under 100KB", () => {
    const small = {
      locals: { "0": { user: { type: "primitive", value: "alice" } } },
    }
    const out = assembleCorrelationData({ forensics: small })!
    expect(out.forensics).toEqual(small)
  })

  it("ignores tokensEstimated when not numeric", () => {
    const out = assembleCorrelationData({
      git: { commit: "a", branch: "b", message: "c", timestamp: "d", dirty: false },
      tokensEstimated: "not a number" as unknown as number,
    })!
    expect(out.tokensEstimated).toBeUndefined()
  })
})

describe("assembleCorrelationData — fuzz / safety", () => {
  /**
   * Random event generator. Produces a mix of valid and junk fields to
   * verify the assembler never throws and never produces fields it shouldn't.
   */
  function randomEvent(seed: number): Record<string, unknown> {
    const rand = (n: number) => Math.floor(Math.abs(Math.sin(seed * n)) * 1000)
    const e: Record<string, unknown> = {}
    if (rand(1) % 2) e.git = { commit: `c${rand(2)}`, branch: "main", message: "m", timestamp: "t", dirty: false }
    if (rand(3) % 3) e.breadcrumbs = Array.from({ length: rand(4) % 30 }, () => ({ timestamp: "t", category: "console", message: "m", level: "info" }))
    if (rand(5) % 2) e.tags = { x: String(rand(6)) }
    if (rand(7) % 4 === 0) e.user = { id: `u${rand(8)}` }
    if (rand(9) % 3 === 0) e.runtimeSnap = { heapMb: rand(10), rssMb: rand(11), eventloopP99Ms: rand(12), openHandles: rand(13) }
    if (rand(14) % 2 === 0) e.schemaVersion = "2.0"
    if (rand(15) % 5 === 0) e.junk_unknown_field = { nested: { stuff: rand(16) } }
    if (rand(17) % 7 === 0) e.tokensEstimated = rand(18)
    return e
  }

  it("never throws across 10K random events", () => {
    let crashed = 0
    let totalOutKeys = 0
    for (let i = 1; i <= 10_000; i++) {
      try {
        const out = assembleCorrelationData(randomEvent(i))
        if (out) totalOutKeys += Object.keys(out).length
      } catch {
        crashed++
      }
    }
    expect(crashed).toBe(0)
    expect(totalOutKeys).toBeGreaterThan(0)
  })

  it("never leaks unknown top-level fields into correlationData", () => {
    const out = assembleCorrelationData({
      title: "leaked?",
      body: "leaked?",
      junk: { stuff: 1 },
      __proto__: { polluted: true },
    })
    if (out) {
      expect(out.junk).toBeUndefined()
      expect(out.title).toBeUndefined()
      expect(out.body).toBeUndefined()
      expect(out.__proto__).toBeUndefined()
    }
  })
})
