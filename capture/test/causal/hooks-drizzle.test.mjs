/**
 * Drizzle hook tests (SKYNET §3 piece 7).
 *
 *   - Patches `*Database.prototype.execute` for each available dialect
 *   - Idempotent (re-install on same prototype is a no-op)
 *   - Missing dialect resolves false without throwing
 *   - Records `drizzle.<dialect>.execute` op with truncated SQL
 *
 * Drizzle dialect modules are stubbed via the loaders argument.
 */

import test from "node:test"
import assert from "node:assert/strict"

import { installDrizzleHook } from "../../dist/causal/hooks-drizzle.js"
import {
  initCausalGraph,
  runWithRoot,
  __resetCausalGraphForTesting,
  __getBufferForTesting,
} from "../../dist/causal/graph.js"

function makeFakePgCore() {
  class PgDatabase {
    async execute(query) {
      return { rows: [], sql: query?.sql ?? String(query) }
    }
  }
  return { PgDatabase }
}

function makeFakeMysqlCore() {
  class MySqlDatabase {
    async execute(query) {
      return [[]]
    }
  }
  return { MySqlDatabase }
}

function withFlag(fn) {
  process.env.CAPTURE_CAUSAL_GRAPH = "1"
  return Promise.resolve(fn()).finally(() => {
    delete process.env.CAPTURE_CAUSAL_GRAPH
  })
}

test("drizzle hook: patches PgDatabase.prototype.execute", async () => {
  __resetCausalGraphForTesting()
  await withFlag(async () => {
    await initCausalGraph()
    const pgCore = makeFakePgCore()
    const installed = await installDrizzleHook({
      pg: async () => pgCore,
      mysql: async () => {
        throw new Error("not installed")
      },
      sqlite: async () => {
        throw new Error("not installed")
      },
    })
    assert.equal(installed, true, "pg dialect patched")

    await new Promise((resolve, reject) => {
      runWithRoot(() => {
        const db = new pgCore.PgDatabase()
        db.execute({ sql: "SELECT * FROM users" })
          .then(() => {
            const buf = __getBufferForTesting()
            assert.equal(buf.nodes.length, 1)
            assert.equal(buf.nodes[0].op, "drizzle.pg.execute")
            assert.equal(buf.nodes[0].attrs.sql, "SELECT * FROM users")
            resolve()
          })
          .catch(reject)
      })
    })
  })
})

test("drizzle hook: idempotent — second install is a no-op", async () => {
  __resetCausalGraphForTesting()
  await withFlag(async () => {
    await initCausalGraph()
    const pgCore = makeFakePgCore()
    const loaders = {
      pg: async () => pgCore,
      mysql: async () => {
        throw new Error("none")
      },
      sqlite: async () => {
        throw new Error("none")
      },
    }
    const first = await installDrizzleHook(loaders)
    const second = await installDrizzleHook(loaders)
    assert.equal(first, true)
    assert.equal(second, false, "second install should not double-patch")
  })
})

test("drizzle hook: every dialect missing → returns false", async () => {
  __resetCausalGraphForTesting()
  await withFlag(async () => {
    await initCausalGraph()
    const installed = await installDrizzleHook({
      pg: async () => {
        throw new Error("none")
      },
      mysql: async () => {
        throw new Error("none")
      },
      sqlite: async () => {
        throw new Error("none")
      },
    })
    assert.equal(installed, false)
  })
})

test("drizzle hook: mysql dialect also covered", async () => {
  __resetCausalGraphForTesting()
  await withFlag(async () => {
    await initCausalGraph()
    const mysqlCore = makeFakeMysqlCore()
    const installed = await installDrizzleHook({
      pg: async () => {
        throw new Error("none")
      },
      mysql: async () => mysqlCore,
      sqlite: async () => {
        throw new Error("none")
      },
    })
    assert.equal(installed, true)

    await new Promise((resolve, reject) => {
      runWithRoot(() => {
        const db = new mysqlCore.MySqlDatabase()
        db.execute({ sql: "SELECT 1" })
          .then(() => {
            const buf = __getBufferForTesting()
            assert.equal(buf.nodes[0].op, "drizzle.mysql.execute")
            resolve()
          })
          .catch(reject)
      })
    })
  })
})
