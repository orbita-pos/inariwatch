/**
 * Prisma hook tests (SKYNET §3 piece 7).
 *
 *   - Prototype patch wraps `_request` and records modelName.action ops
 *   - Idempotent: second install is a no-op
 *   - Missing module: installPrismaHook returns false silently
 *   - Manual instrumentation via `instrumentPrismaClient($on('query'))`
 *
 * Tests use a fake `@prisma/client` exposing the same private API real
 * Prisma uses (v4-v6).
 */

import test from "node:test"
import assert from "node:assert/strict"

import {
  installPrismaHook,
  instrumentPrismaClient,
} from "../../dist/causal/hooks-prisma.js"
import {
  initCausalGraph,
  runWithRoot,
  __resetCausalGraphForTesting,
  __getBufferForTesting,
} from "../../dist/causal/graph.js"

function makeFakePrisma() {
  class FakePrismaClient {
    async _request(params) {
      return { ok: true, params }
    }
  }
  return { PrismaClient: FakePrismaClient }
}

function withFlag(fn) {
  process.env.CAPTURE_CAUSAL_GRAPH = "1"
  return Promise.resolve(fn()).finally(() => {
    delete process.env.CAPTURE_CAUSAL_GRAPH
  })
}

test("prisma hook: patches _request, records prisma.model.action", async () => {
  __resetCausalGraphForTesting()
  await withFlag(async () => {
    await initCausalGraph()
    const fake = makeFakePrisma()
    const installed = await installPrismaHook(async () => fake)
    assert.equal(installed, true)

    await new Promise((resolve, reject) => {
      runWithRoot(() => {
        const client = new fake.PrismaClient()
        client
          ._request({
            modelName: "User",
            action: "findUnique",
            args: { where: { id: 1 } },
          })
          .then(() => {
            const buf = __getBufferForTesting()
            assert.equal(buf.nodes.length, 1)
            assert.equal(buf.nodes[0].op, "prisma.User.findUnique")
            assert.match(String(buf.nodes[0].attrs.args), /where/)
            resolve()
          })
          .catch(reject)
      })
    })
  })
})

test("prisma hook: idempotent on the same prototype", async () => {
  __resetCausalGraphForTesting()
  await withFlag(async () => {
    await initCausalGraph()
    const fake = makeFakePrisma()
    const first = await installPrismaHook(async () => fake)
    const second = await installPrismaHook(async () => fake)
    assert.equal(first, true)
    assert.equal(second, false)
  })
})

test("prisma hook: missing module → installPrismaHook returns false", async () => {
  __resetCausalGraphForTesting()
  await withFlag(async () => {
    await initCausalGraph()
    const installed = await installPrismaHook(async () => {
      throw new Error("Cannot find module '@prisma/client'")
    })
    assert.equal(installed, false)
  })
})

test("prisma hook: instrumentPrismaClient subscribes via $on('query')", async () => {
  __resetCausalGraphForTesting()
  await withFlag(async () => {
    await initCausalGraph()
    const listeners = new Map()
    const client = {
      $on(name, cb) {
        listeners.set(name, cb)
      },
    }
    const ok = instrumentPrismaClient(client)
    assert.equal(ok, true)
    // Calling again on the same client is a no-op.
    assert.equal(instrumentPrismaClient(client), false)

    runWithRoot(() => {
      const cb = listeners.get("query")
      assert.equal(typeof cb, "function", "query listener registered")
      cb({
        query: "SELECT * FROM User WHERE id = $1",
        params: "[1]",
        target: "postgres",
        duration: 12,
      })
      const buf = __getBufferForTesting()
      assert.equal(buf.nodes.length, 1)
      assert.equal(buf.nodes[0].op, "prisma.query")
      assert.equal(buf.nodes[0].durationMs, 12)
    })
  })
})

test("prisma hook: rejection records error attribute", async () => {
  __resetCausalGraphForTesting()
  await withFlag(async () => {
    await initCausalGraph()
    class FailingClient {
      async _request() {
        throw new Error("P2002 unique constraint")
      }
    }
    const fake = { PrismaClient: FailingClient }
    await installPrismaHook(async () => fake)

    await new Promise((resolve) => {
      runWithRoot(() => {
        const client = new fake.PrismaClient()
        client
          ._request({ modelName: "User", action: "create", args: {} })
          .catch(() => {
            const buf = __getBufferForTesting()
            assert.equal(buf.nodes.length, 1)
            assert.match(String(buf.nodes[0].attrs.error), /P2002/)
            resolve()
          })
      })
    })
  })
})
