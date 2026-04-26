/**
 * pg hook tests (SKYNET §3 piece 7).
 *
 *   - Promise API: client.query("SELECT 1") records start + end with rowCount
 *   - Callback API: cb is wrapped, original callback still fires
 *   - Error path: rejection records error attribute
 *   - Idempotent: second install on the same prototype is a no-op
 *   - Driver missing: install resolves false, never throws
 *
 * Tests use a fake `pg` module via the loader seam — no real driver
 * required.
 */

import test from "node:test"
import assert from "node:assert/strict"

import { installPgHook } from "../../dist/causal/hooks-pg.js"
import {
  initCausalGraph,
  runWithRoot,
  __resetCausalGraphForTesting,
  __getBufferForTesting,
} from "../../dist/causal/graph.js"

// Build a fresh fake pg module for each test — avoids cross-test
// contamination from the patch mark.
function makeFakePg() {
  class FakeClient {
    async query(text, params, cb) {
      // Mimic node-postgres: callback OR promise, never both.
      if (typeof cb === "function") {
        setImmediate(() => cb(null, { rowCount: 42 }))
        return
      }
      if (typeof params === "function") {
        setImmediate(() => params(null, { rowCount: 7 }))
        return
      }
      return { rowCount: 1 }
    }
  }
  class FakePool {
    async query(text) {
      return { rowCount: 99 }
    }
  }
  return { Client: FakeClient, Pool: FakePool }
}

function withFlag(fn) {
  process.env.CAPTURE_CAUSAL_GRAPH = "1"
  return Promise.resolve(fn()).finally(() => {
    delete process.env.CAPTURE_CAUSAL_GRAPH
  })
}

test("pg hook: Promise API records causal node with rowCount", async () => {
  __resetCausalGraphForTesting()
  await withFlag(async () => {
    await initCausalGraph()
    const fake = makeFakePg()
    const installed = await installPgHook(async () => fake)
    assert.equal(installed, true, "patch should report success")

    await new Promise((resolve, reject) => {
      runWithRoot(() => {
        const client = new fake.Client()
        client
          .query("SELECT 1")
          .then(() => {
            const buf = __getBufferForTesting()
            assert.equal(buf.nodes.length, 1, "one node recorded")
            assert.equal(buf.nodes[0].op, "pg.client.query")
            assert.equal(buf.nodes[0].attrs.sql, "SELECT 1")
            assert.equal(buf.nodes[0].attrs.rowCount, 1)
            assert.ok(typeof buf.nodes[0].durationMs === "number")
            resolve()
          })
          .catch(reject)
      })
    })
  })
})

test("pg hook: Callback API wraps callback, records on completion", async () => {
  __resetCausalGraphForTesting()
  await withFlag(async () => {
    await initCausalGraph()
    const fake = makeFakePg()
    await installPgHook(async () => fake)

    await new Promise((resolve) => {
      runWithRoot(() => {
        const client = new fake.Client()
        client.query("SELECT 1", (err, res) => {
          // User callback receives the original args.
          assert.equal(err, null)
          assert.equal(res.rowCount, 7)
          // Buffer should already have the recorded node.
          const buf = __getBufferForTesting()
          assert.equal(buf.nodes.length, 1)
          assert.equal(buf.nodes[0].attrs.rowCount, 7)
          resolve()
        })
      })
    })
  })
})

test("pg hook: error path records error attribute", async () => {
  __resetCausalGraphForTesting()
  await withFlag(async () => {
    await initCausalGraph()
    class FailingClient {
      async query() {
        throw new Error("boom")
      }
    }
    const fake = { Client: FailingClient }
    await installPgHook(async () => fake)

    await new Promise((resolve) => {
      runWithRoot(() => {
        const client = new fake.Client()
        client.query("SELECT 1").catch(() => {
          const buf = __getBufferForTesting()
          assert.equal(buf.nodes.length, 1)
          assert.match(String(buf.nodes[0].attrs.error), /boom/)
          resolve()
        })
      })
    })
  })
})

test("pg hook: idempotent — second install on same prototype is a no-op", async () => {
  __resetCausalGraphForTesting()
  await withFlag(async () => {
    await initCausalGraph()
    const fake = makeFakePg()
    const first = await installPgHook(async () => fake)
    const second = await installPgHook(async () => fake)
    assert.equal(first, true)
    assert.equal(second, false, "second install should report no-op")
  })
})

test("pg hook: driver missing → install resolves false silently", async () => {
  __resetCausalGraphForTesting()
  await withFlag(async () => {
    await initCausalGraph()
    const installed = await installPgHook(async () => {
      throw new Error("Cannot find module 'pg'")
    })
    assert.equal(installed, false, "missing driver → false, no throw")
  })
})

test("pg hook: Pool.query also patched", async () => {
  __resetCausalGraphForTesting()
  await withFlag(async () => {
    await initCausalGraph()
    const fake = makeFakePg()
    await installPgHook(async () => fake)

    await new Promise((resolve, reject) => {
      runWithRoot(() => {
        const pool = new fake.Pool()
        pool
          .query("SELECT now()")
          .then(() => {
            const buf = __getBufferForTesting()
            assert.equal(buf.nodes[0].op, "pg.pool.query", "pool op label")
            assert.equal(buf.nodes[0].attrs.rowCount, 99)
            resolve()
          })
          .catch(reject)
      })
    })
  })
})
