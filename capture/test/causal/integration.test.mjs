/**
 * End-to-end integration test (SKYNET §3 piece 7, acceptance demo):
 *
 *   handler that does prisma.user.findUnique → throw  →  payload.graph
 *   shows the prisma node with a causal edge to the throw frame.
 *
 * Builds a v2 wire payload via `prepareV2Payload` and asserts the graph
 * is attached + carries the expected node + the JSON shape matches the
 * frozen `CausalGraph` wire contract.
 *
 * The example payload is logged so `npm test` output doubles as a
 * golden sample for downstream session 2 (HTTP/Redis) work.
 */

import test from "node:test"
import assert from "node:assert/strict"

import { prepareV2Payload } from "../../dist/v2-emit.js"
import { installPrismaHook } from "../../dist/causal/hooks-prisma.js"
import {
  initCausalGraph,
  runWithRoot,
  recordOp,
  __resetCausalGraphForTesting,
} from "../../dist/causal/graph.js"

function makeFakePrisma() {
  class FakePrismaClient {
    async _request(params) {
      // Mimic the user.findUnique returning null which the handler then
      // dereferences and throws a TypeError on.
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

test("acceptance demo: handler with prisma.user.findUnique → throw → payload.graph", async () => {
  __resetCausalGraphForTesting()
  process.env.CAPTURE_CAUSAL_GRAPH = "1"
  process.env.CAPTURE_PAYLOAD_VERSION = "2"
  try {
    await initCausalGraph()
    const fake = makeFakePrisma()
    const ok = await installPrismaHook(async () => fake)
    assert.equal(ok, true, "prisma hook should install")

    // The handler + the prepareV2Payload call must run in the SAME
    // async chain so AsyncLocalStorage hands them the same buffer —
    // exactly what `captureException` inside a real handler does.
    const wire = await new Promise((resolve, reject) => {
      runWithRoot(async () => {
        const handlerHandle = recordOp("handler.GET /user/:id")
        let throwError = null
        try {
          const client = new fake.PrismaClient()
          const user = await client.user.findUnique({ where: { id: 1 } })
          // Deref null user — produces TypeError, mirrors a real bug.
          // eslint-disable-next-line no-unused-expressions
          user.email
        } catch (err) {
          throwError = err
        }
        handlerHandle.end({ error: throwError ?? undefined })
        if (!(throwError instanceof TypeError)) {
          reject(new Error("handler must throw a TypeError"))
          return
        }
        try {
          const event = {
            fingerprint: "f".repeat(64),
            title: `${throwError.name}: ${throwError.message}`,
            body: throwError.stack || `${throwError.name}: ${throwError.message}`,
            severity: "critical",
            timestamp: new Date().toISOString(),
          }
          const out = await prepareV2Payload(event)
          resolve(out)
        } catch (err) {
          reject(err)
        }
      })
    })

    // Wire payload must carry `graph` filled by extractSubgraph.
    assert.ok(wire.graph, "payload.graph attached")
    assert.ok(Array.isArray(wire.graph.nodes), "graph.nodes is an array")
    assert.ok(Array.isArray(wire.graph.edges), "graph.edges is an array")

    const ops = wire.graph.nodes.map((n) => n.label)
    assert.ok(
      ops.some((l) => l.startsWith("prisma.User.findUnique")),
      `graph must include prisma.User.findUnique node, got: ${JSON.stringify(ops)}`,
    )
    assert.ok(
      ops.some((l) => l.startsWith("handler.GET /user/:id")),
      "graph must include the handler frame",
    )

    // There must be a causal edge from the handler to the prisma call.
    const handlerNode = wire.graph.nodes.find((n) => n.label.startsWith("handler.GET"))
    const prismaNode = wire.graph.nodes.find((n) =>
      n.label.startsWith("prisma.User.findUnique"),
    )
    assert.ok(handlerNode && prismaNode)
    const causalEdge = wire.graph.edges.find(
      (e) => e.from === handlerNode.id && e.to === prismaNode.id && e.kind === "causal",
    )
    assert.ok(
      causalEdge,
      `expected causal handler→prisma edge, got edges=${JSON.stringify(wire.graph.edges)}`,
    )

    // Cap holds: <= 200 nodes.
    assert.ok(wire.graph.nodes.length <= 200)

    // Print the example JSON so the test log doubles as a golden sample.
    const example = {
      graph: wire.graph,
      title: wire.title,
    }
    console.log(
      "[causal-graph integration] example payload.graph:",
      JSON.stringify(example, null, 2),
    )
  } finally {
    delete process.env.CAPTURE_CAUSAL_GRAPH
    delete process.env.CAPTURE_PAYLOAD_VERSION
    __resetCausalGraphForTesting()
  }
})
