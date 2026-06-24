/**
 * Cross-service stitching + data-flow integration test
 * (SKYNET §3 piece 7, Track B session 2 acceptance demo).
 *
 * What this test proves:
 *
 *   1. ServiceA records an outbound HTTP call to ServiceB. ServiceB has its
 *      own causal graph; ServiceA's payload graph contains BOTH services'
 *      nodes after stitching, with a causal edge crossing the boundary.
 *
 *   2. JSON.parse(responseBody).id consumed by `prisma.user.findUnique({
 *      where: { id } })` produces a `data-flow` edge from the http node
 *      to the prisma node — so the AI can see "this query failed because
 *      its argument came from THAT response".
 *
 * Both assertions run together because they share the same in-process graph
 * and the same fake undici diagnostics_channel — splitting them would
 * duplicate ~80 lines of fixture for no gain.
 */

import test from "node:test"
import assert from "node:assert/strict"

import {
  initCausalGraph,
  runWithRoot,
  recordOp,
  mergeSubgraph,
  serializeForHeader,
  deserializeFromHeader,
  __resetCausalGraphForTesting,
  __getBufferForTesting,
} from "../../dist/causal/graph.js"
import {
  installHttpHook,
  __resetHttpHookForTesting,
} from "../../dist/causal/hooks-http.js"
import { installPrismaHook } from "../../dist/causal/hooks-prisma.js"
import {
  __resetDataFlowForTesting,
  installJsonParseTaint,
  tagValue,
  findDataFromIds,
} from "../../dist/causal/data-flow.js"

// ── Fake undici diagnostics_channel ────────────────────────────────────────

function makeFakeDiagnosticsChannel() {
  const subscribers = new Map()
  return {
    subscribe(name, cb) {
      const list = subscribers.get(name) ?? []
      list.push(cb)
      subscribers.set(name, list)
    },
    publish(name, payload) {
      for (const cb of subscribers.get(name) ?? []) cb(payload)
    },
  }
}

// Fake fetch that drives the diagnostics_channel and returns a parsed body
// with a stitched X-IW-Subgraph header from "ServiceB". Tests pass in a
// pre-built foreign subgraph to simulate a downstream causal trail.
function makeFakeFetch(dc, foreignSubgraph) {
  return async function fakeFetch(url, init = {}) {
    const headers = []
    const req = {
      origin: new URL(url).origin,
      path: new URL(url).pathname,
      method: (init.method ?? "GET").toUpperCase(),
      headers,
      addHeader(k, v) {
        headers.push(k, v)
      },
    }
    dc.publish("undici:request:create", { request: req })
    // Headers must include the stitched ones.
    const lowerHeaders = {}
    for (let i = 0; i + 1 < headers.length; i += 2) {
      lowerHeaders[String(headers[i]).toLowerCase()] = String(headers[i + 1])
    }

    const subgraphHeader = foreignSubgraph ? serializeSubgraphHeader(foreignSubgraph) : null
    const responseHeaders = {}
    if (subgraphHeader) responseHeaders["x-iw-subgraph"] = subgraphHeader

    dc.publish("undici:request:trailers", {
      request: req,
      response: { headers: responseHeaders },
    })

    return {
      injectedHeaders: lowerHeaders,
      bodyText: JSON.stringify({ id: 42, name: "alice" }),
    }
  }
}

function serializeSubgraphHeader(graph) {
  const json = JSON.stringify(graph)
  return Buffer.from(json, "utf8").toString("base64")
}

// Fake prisma client — same shape as test/causal/integration.test.mjs uses.
function makeFakePrisma() {
  class FakePrismaClient {
    async _request(_params) {
      return null
    }
    get user() {
      return {
        findUnique: (args) =>
          this._request({
            modelName: "User",
            action: "findUnique",
            args,
          }),
      }
    }
  }
  return { PrismaClient: FakePrismaClient }
}

// ── The test ───────────────────────────────────────────────────────────────

test("cross-service: ServiceA HTTP→ServiceB merges graphs + JSON.parse data-flow into prisma", async () => {
  __resetCausalGraphForTesting()
  __resetDataFlowForTesting()
  __resetHttpHookForTesting()
  process.env.CAPTURE_CAUSAL_GRAPH = "1"

  try {
    await initCausalGraph()
    installJsonParseTaint()

    // 1. Build a foreign subgraph that simulates ServiceB's causal trail.
    //    ServiceB processed the request through 3 ops: handler → pg.query.
    const foreignGraph = {
      nodes: [
        { id: "n1", kind: "fn", label: "handler.GET /user (dur=12ms)" },
        { id: "n2", kind: "io", label: "pg.client.query (dur=4ms)" },
      ],
      edges: [{ from: "n1", to: "n2", kind: "causal" }],
    }

    // 2. Wire the HTTP hook against a fake diagnostics_channel.
    const dc = makeFakeDiagnosticsChannel()
    const installed = await installHttpHook(async () => dc)
    assert.equal(installed, true, "http hook should install with fake dc")

    // 3. Wire the prisma hook.
    const fakePrisma = makeFakePrisma()
    const prismaInstalled = await installPrismaHook(async () => fakePrisma)
    assert.equal(prismaInstalled, true, "prisma hook should install")

    const fetch = makeFakeFetch(dc, foreignGraph)

    // 4. Run a fake handler under runWithRoot so the upstream node (the
    //    ServiceA root) is the parent of the http call.
    let prismaCallCompleted = false
    let injectedSessionHeader = null
    let injectedCausalHeader = null
    let snapshot = null
    await new Promise((resolve, reject) => {
      runWithRoot(async () => {
        try {
          const handler = recordOp("handler.GET /api/proxy")
          // Set a window-style session id to validate header injection.
          globalThis.__INARIWATCH_SESSION__ = "session-abc-123"

          const res = await fetch("https://service-b.internal/user/42")
          injectedSessionHeader = res.injectedHeaders["x-iw-session-id"]
          injectedCausalHeader = res.injectedHeaders["x-iw-causal-id"]

          // 5. User parses response body. Patched JSON.parse tags the
          //    result with the http node id.
          const parsed = JSON.parse(res.bodyText)
          assert.equal(parsed.id, 42)

          // 6. User calls prisma with a value derived from parsed body.
          //    `where: parsed` → prisma hook walks args one level and finds
          //    the tagged object, so a data-flow edge fires.
          const client = new fakePrisma.PrismaClient()
          await client.user.findUnique({ where: parsed })
          prismaCallCompleted = true

          handler.end()

          // Snapshot the buffer BEFORE leaving runWithRoot — the slot dies
          // with the scope.
          const live = __getBufferForTesting()
          snapshot = {
            nodes: live.nodes.map((n) => ({ ...n, attrs: { ...(n.attrs ?? {}) } })),
            edges: live.edges.map((e) => ({ ...e })),
          }
          resolve()
        } catch (err) {
          reject(err)
        }
      })
    })

    delete globalThis.__INARIWATCH_SESSION__

    assert.equal(prismaCallCompleted, true)
    assert.equal(injectedSessionHeader, "session-abc-123", "session header injected outbound")
    assert.match(
      injectedCausalHeader,
      /^n[a-z0-9]+$/,
      `causal id header injected outbound (got: ${injectedCausalHeader})`,
    )

    const buf = snapshot
    const ops = buf.nodes.map((n) => n.op)
    const labels = buf.nodes.map((n) => `${n.id}:${n.op}`)

    // ── Assertions ──────────────────────────────────────────────────────
    // Local nodes present
    assert.ok(
      ops.includes("handler.GET /api/proxy"),
      `handler node missing — ops=${JSON.stringify(ops)}`,
    )
    assert.ok(ops.includes("http.get"), `http.get node missing — ops=${JSON.stringify(ops)}`)
    assert.ok(
      ops.some((o) => o.startsWith("prisma.User.findUnique")),
      `prisma node missing — ops=${JSON.stringify(ops)}`,
    )

    // Foreign nodes merged (prefix `service-b.internal:`)
    const foreignLabels = buf.nodes.filter((n) =>
      n.id.startsWith("service-b.internal:"),
    )
    assert.equal(foreignLabels.length, 2, `expected 2 foreign nodes, got ${foreignLabels.length}`)

    // Cross-service edge: http node → first foreign root
    const httpNode = buf.nodes.find((n) => n.op === "http.get")
    assert.ok(httpNode)
    const stitchEdge = buf.edges.find(
      (e) =>
        e.from === httpNode.id &&
        e.to.startsWith("service-b.internal:") &&
        e.kind === "causal",
    )
    assert.ok(
      stitchEdge,
      `expected cross-service stitch edge from http to foreign root, edges=${JSON.stringify(buf.edges)}`,
    )

    // Data-flow edge: http node → prisma node
    const prismaNode = buf.nodes.find((n) => n.op.startsWith("prisma.User."))
    assert.ok(prismaNode)
    const dataFlowEdge = buf.edges.find(
      (e) => e.from === httpNode.id && e.to === prismaNode.id && e.kind === "data-flow",
    )
    assert.ok(
      dataFlowEdge,
      `expected data-flow edge from http to prisma. all edges=${JSON.stringify(buf.edges)}`,
    )

    // Print the merged graph as a golden sample for downstream review.
    const wireGraph = {
      nodes: buf.nodes.map((n) => ({ id: n.id, op: n.op })),
      edges: buf.edges,
    }
    console.log(
      "[cross-service] merged graph:",
      JSON.stringify(wireGraph, null, 2),
    )
  } finally {
    delete process.env.CAPTURE_CAUSAL_GRAPH
    __resetCausalGraphForTesting()
    __resetDataFlowForTesting()
    __resetHttpHookForTesting()
  }
})

// ── Smaller focused tests for the building blocks ─────────────────────────

test("serializeForHeader / deserializeFromHeader: round-trip preserves graph", async () => {
  __resetCausalGraphForTesting()
  process.env.CAPTURE_CAUSAL_GRAPH = "1"
  try {
    await initCausalGraph()
    let header = null
    runWithRoot(() => {
      const a = recordOp("pg.client.query")
      a.end({ durationMs: 5 })
      header = serializeForHeader()
    })
    assert.ok(header, "header should be non-null")
    assert.match(header, /^[A-Za-z0-9+/=]+$/, "header is base64")

    const decoded = deserializeFromHeader(header)
    assert.ok(decoded)
    assert.ok(decoded.nodes.length >= 1)
    assert.ok(decoded.nodes.some((n) => n.label.startsWith("pg.client.query")))
  } finally {
    delete process.env.CAPTURE_CAUSAL_GRAPH
    __resetCausalGraphForTesting()
  }
})

test("mergeSubgraph: respects 200-node cap, drops oldest foreign nodes", async () => {
  __resetCausalGraphForTesting()
  process.env.CAPTURE_CAUSAL_GRAPH = "1"
  try {
    await initCausalGraph()
    let result = null
    let foreignIds = null
    runWithRoot(() => {
      // Fill the local buffer with 195 nodes
      for (let i = 0; i < 195; i++) {
        const h = recordOp(`local.${i}`)
        h.end({ durationMs: 1 })
      }
      // Foreign graph with 10 nodes — only 5 should fit
      const foreign = {
        nodes: Array.from({ length: 10 }, (_, i) => ({
          id: `f${i}`,
          kind: "io",
          label: `foreign.${i}`,
        })),
        edges: [],
      }
      result = mergeSubgraph(foreign, "remote")

      const buf = __getBufferForTesting()
      foreignIds = buf.nodes
        .filter((n) => n.id.startsWith("remote:"))
        .map((n) => n.id)
    })
    assert.equal(result.merged, 5)
    assert.equal(result.skipped, 5)
    // Remaining foreign nodes are the LAST 5 (closest to throw)
    assert.deepEqual(foreignIds, [
      "remote:f5",
      "remote:f6",
      "remote:f7",
      "remote:f8",
      "remote:f9",
    ])
  } finally {
    delete process.env.CAPTURE_CAUSAL_GRAPH
    __resetCausalGraphForTesting()
  }
})

test("data-flow: tagValue + findDataFromIds matches at one and two levels", async () => {
  __resetCausalGraphForTesting()
  __resetDataFlowForTesting()
  process.env.CAPTURE_CAUSAL_GRAPH = "1"
  try {
    await initCausalGraph()
    const responseObj = { id: 99, name: "bob" }
    tagValue(responseObj, "n42")

    // Direct hit (the response is the arg)
    assert.deepEqual(findDataFromIds([responseObj]), ["n42"])

    // One-level walk: { where: responseObj }
    assert.deepEqual(findDataFromIds([{ where: responseObj }]), ["n42"])

    // Primitive arg → no match
    assert.deepEqual(findDataFromIds(["just-a-string"]), [])

    // Untagged value → no match
    assert.deepEqual(findDataFromIds([{ id: 1 }]), [])
  } finally {
    delete process.env.CAPTURE_CAUSAL_GRAPH
    __resetCausalGraphForTesting()
    __resetDataFlowForTesting()
  }
})

test("JSON.parse taint: window opens after pending mark, closes after one parse", async () => {
  __resetCausalGraphForTesting()
  __resetDataFlowForTesting()
  process.env.CAPTURE_CAUSAL_GRAPH = "1"
  try {
    await initCausalGraph()
    installJsonParseTaint()
    const { markPendingHttpProvenance, getProvenance } = await import(
      "../../dist/causal/data-flow.js"
    )
    markPendingHttpProvenance("nXYZ")
    const parsed = JSON.parse('{"id":7}')
    assert.equal(getProvenance(parsed), "nXYZ", "first parse inherits provenance")

    const second = JSON.parse('{"id":8}')
    assert.equal(getProvenance(second), null, "second parse does NOT inherit")
  } finally {
    delete process.env.CAPTURE_CAUSAL_GRAPH
    __resetCausalGraphForTesting()
    __resetDataFlowForTesting()
  }
})
