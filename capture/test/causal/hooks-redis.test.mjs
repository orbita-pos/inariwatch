/**
 * ioredis hook tests (SKYNET §3 piece 7, Track B session 2).
 *
 *   - Promise API: client.sendCommand({...}) records redis.<cmd> with args
 *   - Error path: rejected sendCommand records error attribute
 *   - Idempotent: second install on the same prototype is a no-op
 *   - Driver missing: install resolves false, never throws
 *   - Data-flow: a tagged arg produces a data-flow edge into the redis node
 *
 * Tests use a fake `ioredis` module via the loader seam — no real driver
 * required.
 */

import test from "node:test"
import assert from "node:assert/strict"

import { installRedisHook } from "../../dist/causal/hooks-redis.js"
import {
  initCausalGraph,
  runWithRoot,
  recordOp,
  __resetCausalGraphForTesting,
  __getBufferForTesting,
} from "../../dist/causal/graph.js"
import {
  tagValue,
  __resetDataFlowForTesting,
} from "../../dist/causal/data-flow.js"

function makeFakeIoredis() {
  class FakeRedis {
    sendCommand(command) {
      // ioredis returns an object with a `.promise` field that resolves with
      // the command result.
      return {
        name: command.name,
        args: command.args,
        promise: Promise.resolve("OK"),
      }
    }
  }
  return { Redis: FakeRedis }
}

function withFlag(fn) {
  process.env.CAPTURE_CAUSAL_GRAPH = "1"
  return Promise.resolve(fn()).finally(() => {
    delete process.env.CAPTURE_CAUSAL_GRAPH
  })
}

test("redis hook: records redis.get with command name + args", async () => {
  __resetCausalGraphForTesting()
  await withFlag(async () => {
    await initCausalGraph()
    const fake = makeFakeIoredis()
    const ok = await installRedisHook(async () => fake)
    assert.equal(ok, true)

    let bufSnapshot = null
    await new Promise((resolve, reject) => {
      runWithRoot(async () => {
        try {
          const client = new fake.Redis()
          const ret = client.sendCommand({ name: "GET", args: ["user:42"] })
          await ret.promise

          const live = __getBufferForTesting()
          bufSnapshot = {
            nodes: live.nodes.map((n) => ({ ...n })),
            edges: live.edges.map((e) => ({ ...e })),
          }
          resolve()
        } catch (err) {
          reject(err)
        }
      })
    })

    const ops = bufSnapshot.nodes.map((n) => n.op)
    assert.ok(ops.includes("redis.get"), `expected redis.get, got ${JSON.stringify(ops)}`)
    const node = bufSnapshot.nodes.find((n) => n.op === "redis.get")
    assert.ok(node.attrs?.args?.includes("user:42"), `args missing: ${JSON.stringify(node.attrs)}`)
    assert.equal(typeof node.durationMs, "number")
  })
})

test("redis hook: data-flow edge from tagged arg", async () => {
  __resetCausalGraphForTesting()
  __resetDataFlowForTesting()
  await withFlag(async () => {
    await initCausalGraph()
    const fake = makeFakeIoredis()
    await installRedisHook(async () => fake)

    let bufSnapshot = null
    await new Promise((resolve, reject) => {
      runWithRoot(async () => {
        try {
          // Simulate: HTTP response was tagged, then passed into redis SET
          const httpHandle = recordOp("http.get", { url: "https://x" })
          const responseObj = { id: 7, blob: "v" }
          tagValue(responseObj, httpHandle.id)
          httpHandle.end({ durationMs: 1 })

          const client = new fake.Redis()
          const ret = client.sendCommand({
            name: "SET",
            args: ["key", responseObj],
          })
          await ret.promise

          const live = __getBufferForTesting()
          bufSnapshot = {
            nodes: live.nodes.map((n) => ({ ...n })),
            edges: live.edges.map((e) => ({ ...e })),
          }
          resolve()
        } catch (err) {
          reject(err)
        }
      })
    })

    const httpNode = bufSnapshot.nodes.find((n) => n.op === "http.get")
    const redisNode = bufSnapshot.nodes.find((n) => n.op === "redis.set")
    assert.ok(httpNode && redisNode)
    const dataFlow = bufSnapshot.edges.find(
      (e) => e.from === httpNode.id && e.to === redisNode.id && e.kind === "data-flow",
    )
    assert.ok(
      dataFlow,
      `expected data-flow edge http→redis. edges=${JSON.stringify(bufSnapshot.edges)}`,
    )
  })
})

test("redis hook: idempotent — second install on same prototype is no-op", async () => {
  __resetCausalGraphForTesting()
  const fake = makeFakeIoredis()
  const first = await installRedisHook(async () => fake)
  const second = await installRedisHook(async () => fake)
  assert.equal(first, true)
  assert.equal(second, false)
})

test("redis hook: driver missing → resolves false, never throws", async () => {
  __resetCausalGraphForTesting()
  const result = await installRedisHook(async () => {
    throw new Error("ENOENT")
  })
  assert.equal(result, false)
})

test("redis hook: error path records error attribute on node", async () => {
  __resetCausalGraphForTesting()
  await withFlag(async () => {
    await initCausalGraph()
    class FailingRedis {
      sendCommand(_command) {
        return { promise: Promise.reject(new Error("READONLY")) }
      }
    }
    const fake = { Redis: FailingRedis }
    await installRedisHook(async () => fake)

    let bufSnapshot = null
    await new Promise((resolve) => {
      runWithRoot(async () => {
        const client = new fake.Redis()
        const ret = client.sendCommand({ name: "SET", args: ["k", "v"] })
        try {
          await ret.promise
        } catch {
          // expected
        }
        const live = __getBufferForTesting()
        bufSnapshot = {
          nodes: live.nodes.map((n) => ({ ...n, attrs: { ...(n.attrs ?? {}) } })),
          edges: live.edges.map((e) => ({ ...e })),
        }
        resolve()
      })
    })
    const node = bufSnapshot.nodes.find((n) => n.op === "redis.set")
    assert.ok(node)
    assert.match(String(node.attrs?.error ?? ""), /READONLY/)
  })
})
