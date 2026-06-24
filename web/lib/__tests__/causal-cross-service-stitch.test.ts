/**
 * Server-side cross-service causal graph stitcher tests.
 *
 * Mirror of the SDK-side merge logic in
 * `capture/src/causal/graph.ts:mergeSubgraph` so a graph stitched server-
 * side from sibling alerts is indistinguishable from one stitched in-process
 * by the upstream SDK.
 */

import { describe, it, expect } from "vitest"
import {
  stitchCrossServiceGraphs,
  extractGraphFromCorrelationData,
  type StitchInputAlert,
} from "@/lib/causal/cross-service-stitch"
import type { CausalGraph } from "@/lib/causal/types"

const G = (
  nodes: Array<[string, string]>,
  edges: Array<[string, string, "causal" | "temporal" | "data"]> = [],
): CausalGraph => ({
  nodes: nodes.map(([id, label]) => ({ id, kind: "io", label })),
  edges: edges.map(([from, to, kind]) => ({ from, to, kind })),
})

describe("stitchCrossServiceGraphs", () => {
  it("merges a sibling subgraph and adds a stitch edge from the upstream root", () => {
    const primary: StitchInputAlert = {
      id: "a-1",
      sessionId: "s-x",
      origin: "service-a",
      graph: G([["n1", "handler"]]),
      rootNodeId: "n1",
    }
    const sibling: StitchInputAlert = {
      id: "a-2",
      sessionId: "s-x",
      origin: "service-b",
      graph: G(
        [
          ["n1", "downstream.handler"],
          ["n2", "downstream.pg"],
        ],
        [["n1", "n2", "causal"]],
      ),
    }

    const result = stitchCrossServiceGraphs(primary, [sibling])
    expect(result.merged).toBe(2)
    expect(result.skipped).toBe(0)
    expect(result.origins).toEqual(["service-b"])

    const ids = result.graph.nodes.map((n) => n.id)
    expect(ids).toContain("n1")
    expect(ids).toContain("service-b:n1")
    expect(ids).toContain("service-b:n2")

    // Foreign-internal edge survives, with prefixed ids
    expect(result.graph.edges).toContainEqual({
      from: "service-b:n1",
      to: "service-b:n2",
      kind: "causal",
    })

    // Stitch edge: upstream root → foreign root
    expect(result.graph.edges).toContainEqual({
      from: "n1",
      to: "service-b:n1",
      kind: "causal",
    })

    // Foreign label is namespaced for visibility
    const foreignNode = result.graph.nodes.find((n) => n.id === "service-b:n1")
    expect(foreignNode?.label).toBe("[service-b] downstream.handler")
  })

  it("rejects siblings with mismatched session ids", () => {
    const primary: StitchInputAlert = {
      id: "a-1",
      sessionId: "s-x",
      origin: "a",
      graph: G([["n1", "h"]]),
    }
    const wrong: StitchInputAlert = {
      id: "a-2",
      sessionId: "s-OTHER",
      origin: "b",
      graph: G([["n1", "x"]]),
    }
    const result = stitchCrossServiceGraphs(primary, [wrong])
    expect(result.merged).toBe(0)
    expect(result.origins).toEqual([])
  })

  it("respects the 200-node cap and reports skipped count", () => {
    const local = G(
      Array.from({ length: 195 }, (_, i) => [`l${i}`, `local.${i}`] as [string, string]),
    )
    const sibling: StitchInputAlert = {
      id: "a-2",
      sessionId: "s-x",
      origin: "b",
      graph: G(Array.from({ length: 10 }, (_, i) => [`f${i}`, `f.${i}`] as [string, string])),
    }
    const result = stitchCrossServiceGraphs(
      { id: "a-1", sessionId: "s-x", origin: "a", graph: local },
      [sibling],
    )
    expect(result.merged).toBe(5)
    expect(result.skipped).toBe(5)
    const foreignIds = result.graph.nodes
      .filter((n) => n.id.startsWith("b:"))
      .map((n) => n.id)
    expect(foreignIds).toEqual(["b:f5", "b:f6", "b:f7", "b:f8", "b:f9"])
  })

  it("merges multiple siblings preserving each origin prefix", () => {
    const primary: StitchInputAlert = {
      id: "a-1",
      sessionId: "s",
      origin: "a",
      graph: G([["n1", "h"]]),
      rootNodeId: "n1",
    }
    const result = stitchCrossServiceGraphs(primary, [
      { id: "a-2", sessionId: "s", origin: "b", graph: G([["x", "x"]]) },
      { id: "a-3", sessionId: "s", origin: "c", graph: G([["y", "y"]]) },
    ])
    expect(result.origins).toEqual(["b", "c"])
    expect(result.graph.nodes.map((n) => n.id)).toEqual(["n1", "b:x", "c:y"])
    // Both foreign roots get stitch edges from the primary root
    expect(result.graph.edges).toContainEqual({ from: "n1", to: "b:x", kind: "causal" })
    expect(result.graph.edges).toContainEqual({ from: "n1", to: "c:y", kind: "causal" })
  })

  it("handles primary with no graph (siblings-only stitch)", () => {
    const primary: StitchInputAlert = {
      id: "a-1",
      sessionId: "s",
      origin: "a",
      graph: null,
    }
    const result = stitchCrossServiceGraphs(primary, [
      { id: "a-2", sessionId: "s", origin: "b", graph: G([["n", "x"]]) },
    ])
    expect(result.merged).toBe(1)
    expect(result.graph.nodes.map((n) => n.id)).toEqual(["b:n"])
  })
})

describe("extractGraphFromCorrelationData", () => {
  it("returns the graph from v2 wire shape (`graph` field)", () => {
    const cd = { graph: G([["n", "x"]]) }
    expect(extractGraphFromCorrelationData(cd)).toEqual(cd.graph)
  })

  it("falls back to legacy `causalGraph` field", () => {
    const cd = { causalGraph: G([["n", "x"]]) }
    expect(extractGraphFromCorrelationData(cd)).toEqual(cd.causalGraph)
  })

  it("returns null on missing or malformed data", () => {
    expect(extractGraphFromCorrelationData(null)).toBeNull()
    expect(extractGraphFromCorrelationData({})).toBeNull()
    expect(extractGraphFromCorrelationData({ graph: { nodes: "no" } })).toBeNull()
    expect(extractGraphFromCorrelationData("string")).toBeNull()
  })
})
