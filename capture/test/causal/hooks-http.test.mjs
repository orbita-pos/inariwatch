/**
 * undici HTTP hook tests (SKYNET §3 piece 7, Track B session 2).
 *
 *   - subscribe wires create / trailers / error events
 *   - outbound headers x-iw-causal-id + x-iw-session-id are injected
 *   - response x-iw-subgraph header merges the foreign graph with a
 *     causal stitch edge
 *   - request error path records error on node
 *   - install returns false when diagnostics_channel cannot be loaded
 *
 * Tests use a fake diagnostics_channel via the loader seam — no real
 * undici / network required.
 */

import test from "node:test"
import assert from "node:assert/strict"

import {
  installHttpHook,
  __resetHttpHookForTesting,
  __HTTP_HEADERS,
} from "../../dist/causal/hooks-http.js"
import {
  initCausalGraph,
  runWithRoot,
  __resetCausalGraphForTesting,
  __getBufferForTesting,
} from "../../dist/causal/graph.js"
import { __resetDataFlowForTesting } from "../../dist/causal/data-flow.js"

function makeDc() {
  const subs = new Map()
  return {
    subscribe(name, cb) {
      const list = subs.get(name) ?? []
      list.push(cb)
      subs.set(name, list)
    },
    publish(name, payload) {
      for (const cb of subs.get(name) ?? []) cb(payload)
    },
  }
}

function withFlag(fn) {
  process.env.CAPTURE_CAUSAL_GRAPH = "1"
  return Promise.resolve(fn()).finally(() => {
    delete process.env.CAPTURE_CAUSAL_GRAPH
  })
}

test("http hook: outbound request injects causal + session headers", async () => {
  __resetCausalGraphForTesting()
  __resetHttpHookForTesting()
  __resetDataFlowForTesting()
  await withFlag(async () => {
    await initCausalGraph()
    const dc = makeDc()
    const ok = await installHttpHook(async () => dc)
    assert.equal(ok, true)

    let injectedKeys = []
    let injectedValues = {}
    let bufSnapshot = null

    await new Promise((resolve) => {
      runWithRoot(() => {
        globalThis.__INARIWATCH_SESSION__ = "sess-X"
        const headers = []
        const req = {
          origin: "https://api.example",
          path: "/v1/widgets",
          method: "POST",
          headers,
          addHeader(k, v) {
            headers.push(k, v)
          },
        }
        dc.publish("undici:request:create", { request: req })
        for (let i = 0; i + 1 < headers.length; i += 2) {
          injectedKeys.push(headers[i].toLowerCase())
          injectedValues[headers[i].toLowerCase()] = headers[i + 1]
        }
        dc.publish("undici:request:trailers", { request: req, response: { headers: {} } })

        const live = __getBufferForTesting()
        bufSnapshot = {
          nodes: live.nodes.map((n) => ({ ...n, attrs: { ...(n.attrs ?? {}) } })),
        }
        delete globalThis.__INARIWATCH_SESSION__
        resolve()
      })
    })

    assert.ok(injectedKeys.includes(__HTTP_HEADERS.CAUSAL))
    assert.ok(injectedKeys.includes(__HTTP_HEADERS.SESSION))
    assert.equal(injectedValues[__HTTP_HEADERS.SESSION], "sess-X")
    const httpNode = bufSnapshot.nodes.find((n) => n.op === "http.post")
    assert.ok(httpNode, `http.post node missing — nodes=${JSON.stringify(bufSnapshot.nodes)}`)
    assert.equal(httpNode.attrs.method, "POST")
    assert.match(httpNode.attrs.url, /widgets$/)
  })
})

test("http hook: x-iw-subgraph response header merges foreign graph", async () => {
  __resetCausalGraphForTesting()
  __resetHttpHookForTesting()
  __resetDataFlowForTesting()
  await withFlag(async () => {
    await initCausalGraph()
    const dc = makeDc()
    await installHttpHook(async () => dc)

    const foreign = {
      nodes: [
        { id: "fA", kind: "fn", label: "downstream.handler" },
        { id: "fB", kind: "io", label: "downstream.pg" },
      ],
      edges: [{ from: "fA", to: "fB", kind: "causal" }],
    }
    const subgraphHeader = Buffer.from(JSON.stringify(foreign), "utf8").toString("base64")

    let bufSnapshot = null
    await new Promise((resolve) => {
      runWithRoot(() => {
        const req = {
          origin: "https://svc-b.local",
          path: "/users",
          method: "GET",
          headers: [],
          addHeader(k, v) {
            this.headers.push(k, v)
          },
        }
        dc.publish("undici:request:create", { request: req })
        dc.publish("undici:request:trailers", {
          request: req,
          response: { headers: { "x-iw-subgraph": subgraphHeader } },
        })
        const live = __getBufferForTesting()
        bufSnapshot = {
          nodes: live.nodes.map((n) => ({ ...n })),
          edges: live.edges.map((e) => ({ ...e })),
        }
        resolve()
      })
    })

    const foreignNodes = bufSnapshot.nodes.filter((n) => n.id.startsWith("svc-b.local:"))
    assert.equal(foreignNodes.length, 2)
    const httpNode = bufSnapshot.nodes.find((n) => n.op === "http.get")
    const stitch = bufSnapshot.edges.find(
      (e) => e.from === httpNode.id && e.to.startsWith("svc-b.local:") && e.kind === "causal",
    )
    assert.ok(stitch, `expected stitch edge, got ${JSON.stringify(bufSnapshot.edges)}`)
  })
})

test("http hook: error event records error attribute", async () => {
  __resetCausalGraphForTesting()
  __resetHttpHookForTesting()
  __resetDataFlowForTesting()
  await withFlag(async () => {
    await initCausalGraph()
    const dc = makeDc()
    await installHttpHook(async () => dc)

    let bufSnapshot = null
    await new Promise((resolve) => {
      runWithRoot(() => {
        const req = {
          origin: "https://broken.test",
          path: "/x",
          method: "GET",
          headers: [],
          addHeader(k, v) {
            this.headers.push(k, v)
          },
        }
        dc.publish("undici:request:create", { request: req })
        dc.publish("undici:request:error", { request: req, error: new Error("ECONNRESET") })
        const live = __getBufferForTesting()
        bufSnapshot = {
          nodes: live.nodes.map((n) => ({ ...n, attrs: { ...(n.attrs ?? {}) } })),
        }
        resolve()
      })
    })
    const node = bufSnapshot.nodes.find((n) => n.op === "http.get")
    assert.ok(node)
    assert.match(String(node.attrs?.error ?? ""), /ECONNRESET/)
  })
})

test("http hook: idempotent — second install returns false", async () => {
  __resetHttpHookForTesting()
  const dc = makeDc()
  const first = await installHttpHook(async () => dc)
  const second = await installHttpHook(async () => dc)
  assert.equal(first, true)
  assert.equal(second, false)
})

test("http hook: diagnostics_channel missing → resolves false", async () => {
  __resetHttpHookForTesting()
  const result = await installHttpHook(async () => {
    throw new Error("ENOENT")
  })
  assert.equal(result, false)
})
