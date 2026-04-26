/**
 * Causal Graph foundation tests (SKYNET §3 piece 7, session 1).
 *
 *   - flag off → every API is a no-op (no nodes recorded, no graph emitted)
 *   - recordOp builds nodes + causal/temporal edges correctly under
 *     a fresh runWithRoot scope
 *   - nested recordOp ends restore the parent so the tree stays a tree
 *     (not a degenerate chain)
 *   - 200-node cap evicts oldest first and drops dangling edges
 *   - extractSubgraph BFS walks parent chain depth N and stops there
 *   - serializeForPayload yields the frozen wire shape (no extra fields)
 *   - runWithRoot isolates concurrent async chains
 *
 * Run from `capture/`:
 *   npm test
 */

import test from "node:test"
import assert from "node:assert/strict"

import {
  initCausalGraph,
  runWithRoot,
  recordOp,
  getCurrentNodeId,
  extractSubgraph,
  serializeForPayload,
  __resetCausalGraphForTesting,
  __getBufferForTesting,
  __isAlsActiveForTesting,
} from "../../dist/causal/graph.js"

const FLAG = "CAPTURE_CAUSAL_GRAPH"

function setFlag(on) {
  if (on) process.env[FLAG] = "1"
  else delete process.env[FLAG]
}

async function withGraph(fn) {
  __resetCausalGraphForTesting()
  setFlag(true)
  await initCausalGraph()
  try {
    await fn()
  } finally {
    setFlag(false)
    __resetCausalGraphForTesting()
  }
}

// ── Flag off: no-op contract ──────────────────────────────────────────────

test("flag off: every API short-circuits to no-op", async () => {
  __resetCausalGraphForTesting()
  setFlag(false)
  await initCausalGraph()

  const handle = recordOp("pg.query", { sql: "SELECT 1" })
  assert.equal(handle.id, "", "RecordHandle.id must be empty when flag is off")
  handle.end({ durationMs: 5 })

  assert.equal(getCurrentNodeId(), null, "current id must be null when flag off")
  assert.equal(serializeForPayload(), undefined, "serializeForPayload returns undefined when flag off")
  assert.equal(extractSubgraph(), undefined, "extractSubgraph returns undefined when flag off")
})

// ── Basic recording ────────────────────────────────────────────────────────

test("recordOp builds nodes and causal/temporal edges in nested scope", async () => {
  await withGraph(async () => {
    runWithRoot(() => {
      const a = recordOp("pg.client.query", { sql: "SELECT 1" })
      const b = recordOp("pg.client.query", { sql: "SELECT 2" })
      b.end({ durationMs: 3 })
      const c = recordOp("pg.client.query", { sql: "SELECT 3" })
      c.end({ durationMs: 4 })
      a.end({ durationMs: 10 })

      const buf = __getBufferForTesting()
      assert.equal(buf.nodes.length, 3, "three ops recorded")
      assert.equal(buf.nodes[0].op, "pg.client.query")

      // a is parent of b and c (causal); b precedes c (temporal sibling).
      const causal = buf.edges.filter((e) => e.kind === "causal")
      const temporal = buf.edges.filter((e) => e.kind === "temporal")
      assert.equal(causal.length, 2, "two causal edges (a→b, a→c)")
      assert.equal(temporal.length, 1, "one temporal edge (b→c)")

      const aId = buf.nodes[0].id
      const bId = buf.nodes[1].id
      const cId = buf.nodes[2].id
      assert.ok(causal.some((e) => e.from === aId && e.to === bId))
      assert.ok(causal.some((e) => e.from === aId && e.to === cId))
      assert.ok(temporal.some((e) => e.from === bId && e.to === cId))

      // b's end set durationMs.
      assert.equal(buf.nodes[1].durationMs, 3)
    })
  })
})

test("nested handle.end restores the parent so siblings stay siblings", async () => {
  await withGraph(async () => {
    runWithRoot(() => {
      const root = recordOp("handler")
      const a = recordOp("pg.client.query")
      a.end()
      const b = recordOp("pg.client.query")
      b.end()
      root.end()

      const buf = __getBufferForTesting()
      // root → a, root → b (causal); a → b temporal.
      const causal = buf.edges.filter((e) => e.kind === "causal")
      assert.equal(causal.length, 2, "both children share root as parent")
      const rootId = buf.nodes[0].id
      assert.ok(causal.every((e) => e.from === rootId))
    })
  })
})

// ── 200-node cap ───────────────────────────────────────────────────────────

test("buffer caps at 200 nodes, evicts oldest, drops dangling edges", async () => {
  await withGraph(async () => {
    runWithRoot(() => {
      const root = recordOp("handler")
      for (let i = 0; i < 220; i++) {
        const h = recordOp(`pg.client.query.${i}`)
        h.end()
      }
      root.end()

      const buf = __getBufferForTesting()
      assert.ok(buf.nodes.length <= 200, `node count must cap at 200 (got ${buf.nodes.length})`)
      // Every edge endpoint must point to a node still present in the buffer.
      const ids = new Set(buf.nodes.map((n) => n.id))
      for (const e of buf.edges) {
        assert.ok(ids.has(e.from), `edge.from ${e.from} must still exist`)
        assert.ok(ids.has(e.to), `edge.to ${e.to} must still exist`)
      }
    })
  })
})

// ── extractSubgraph BFS depth ──────────────────────────────────────────────

test("extractSubgraph walks parent chain to depth N", async () => {
  await withGraph(async () => {
    let leafId
    runWithRoot(() => {
      const a = recordOp("a")
      const b = recordOp("b")
      const c = recordOp("c")
      const d = recordOp("d")
      const e = recordOp("e")
      const f = recordOp("f")
      const g = recordOp("g")
      leafId = g.id
      g.end(); f.end(); e.end(); d.end(); c.end(); b.end(); a.end()

      // depth 2 from leaf g should pull g, f (parent), e (grandparent),
      // and adjacent nodes — but not "a" which is 6 hops up.
      const sub = extractSubgraph(leafId, 2, 200)
      assert.ok(sub, "subgraph must be defined")
      const ids = new Set(sub.nodes.map((n) => n.id))
      assert.ok(ids.has(leafId), "leaf must be included")
      // Chain from leaf walks at most depth 2; nodes more than 2 hops away
      // should be absent. Concretely: a is 6 parents above g.
      assert.ok(!ids.has(a.id), "node 6 hops away must NOT be included at depth 2")
    })
  })
})

test("extractSubgraph returns undefined when buffer is empty", async () => {
  await withGraph(async () => {
    runWithRoot(() => {
      const sub = extractSubgraph()
      assert.equal(sub, undefined, "empty buffer → undefined")
    })
  })
})

// ── serializeForPayload wire shape ─────────────────────────────────────────

test("serializeForPayload returns the frozen CausalGraph wire shape", async () => {
  await withGraph(async () => {
    runWithRoot(() => {
      const a = recordOp("pg.client.query")
      a.end({ durationMs: 7 })
      const wire = serializeForPayload()
      assert.ok(wire, "graph emitted")
      assert.ok(Array.isArray(wire.nodes))
      assert.ok(Array.isArray(wire.edges))
      // Every node has exactly { id, kind, label } (the wire contract).
      for (const node of wire.nodes) {
        assert.equal(typeof node.id, "string")
        assert.equal(typeof node.kind, "string")
        assert.equal(typeof node.label, "string")
        const extra = Object.keys(node).filter((k) => !["id", "kind", "label"].includes(k))
        assert.deepEqual(extra, [], `node has no extra fields, got ${extra.join(",")}`)
      }
      // Edge kinds collapse "data-flow" → "data" to match types.ts.
      for (const edge of wire.edges) {
        assert.ok(
          ["causal", "temporal", "data"].includes(edge.kind),
          `edge.kind must be wire kind, got ${edge.kind}`,
        )
      }
      // Duration baked into label so the wire shape stays frozen.
      assert.match(
        wire.nodes[0].label,
        /pg\.client\.query \(dur=7ms\)/,
        "duration baked into label",
      )
    })
  })
})

// ── runWithRoot isolation ──────────────────────────────────────────────────

test("runWithRoot isolates concurrent async chains", async () => {
  await withGraph(async () => {
    if (!__isAlsActiveForTesting()) {
      // No async_hooks on this runtime — skip.
      return
    }
    const r1 = new Promise((resolve) => {
      runWithRoot(() => {
        recordOp("a1").end()
        recordOp("a2").end()
        // Read inside the scope — must see only a1, a2.
        const buf = __getBufferForTesting()
        const ops = buf.nodes.map((n) => n.op)
        resolve(ops)
      })
    })
    const r2 = new Promise((resolve) => {
      runWithRoot(() => {
        recordOp("b1").end()
        const buf = __getBufferForTesting()
        const ops = buf.nodes.map((n) => n.op)
        resolve(ops)
      })
    })
    const [ops1, ops2] = await Promise.all([r1, r2])
    assert.deepEqual(ops1, ["a1", "a2"], "scope 1 sees only a1/a2")
    assert.deepEqual(ops2, ["b1"], "scope 2 sees only b1")
  })
})

// ── data-flow edges ────────────────────────────────────────────────────────

test("data-flow edges link producers to consumers", async () => {
  await withGraph(async () => {
    runWithRoot(() => {
      const producer = recordOp("pg.client.query", { sql: "SELECT id" })
      producer.end({ durationMs: 1 })
      const consumer = recordOp("handler.use-id")
      consumer.end({ durationMs: 1, dataFrom: [producer.id] })

      const buf = __getBufferForTesting()
      const dataEdges = buf.edges.filter((e) => e.kind === "data-flow")
      assert.equal(dataEdges.length, 1, "one data-flow edge")
      assert.equal(dataEdges[0].from, producer.id)
      assert.equal(dataEdges[0].to, consumer.id)
    })
  })
})

// ── Idempotent end ─────────────────────────────────────────────────────────

test("handle.end is idempotent — calling twice does not duplicate state", async () => {
  await withGraph(async () => {
    runWithRoot(() => {
      const h = recordOp("pg.client.query")
      h.end({ durationMs: 5 })
      h.end({ durationMs: 999, error: new Error("late") })
      const buf = __getBufferForTesting()
      assert.equal(buf.nodes[0].durationMs, 5, "second end is ignored")
      assert.equal(buf.nodes[0].attrs?.error, undefined, "late error is ignored")
    })
  })
})
