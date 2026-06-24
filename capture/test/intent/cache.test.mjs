/**
 * Intent compiler — cache behavior + acceptance gate (SKYNET §3 piece 5).
 *
 *   - First lookup is a miss; subsequent lookups for the same (file,
 *     symbol) hit the cache without re-parsing
 *   - Mutating the file's mtime invalidates the entry
 *   - Hit ratio across a realistic loop (1 cold + N warm) is >90%
 */

import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { utimesSync, statSync } from "node:fs"

import {
  extractIntentForFrame,
  __resetCacheForTesting,
  __getCacheStats,
  __cacheHitRatio,
} from "../../dist/intent/index.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = (name) => join(__dirname, "fixtures", name)

test("cache: second call for same (file, symbol) is a hit", () => {
  __resetCacheForTesting()
  const frame = {
    file: FIXTURE("handler-with-user-type.ts"),
    line: 12,
    function: "handler",
  }
  extractIntentForFrame(frame)
  let stats = __getCacheStats()
  assert.equal(stats.misses, 1)
  assert.equal(stats.hits, 0)

  extractIntentForFrame(frame)
  extractIntentForFrame(frame)
  stats = __getCacheStats()
  assert.equal(stats.misses, 1)
  assert.equal(stats.hits, 2)
})

test("cache: bumping mtime forces a re-parse (miss)", () => {
  __resetCacheForTesting()
  const file = FIXTURE("handler-with-user-type.ts")
  const frame = { file, line: 12, function: "handler" }
  extractIntentForFrame(frame)
  extractIntentForFrame(frame)
  assert.equal(__getCacheStats().hits, 1)

  // Touch mtime forward by 5s
  const st = statSync(file)
  const newTime = new Date(st.mtimeMs + 5000)
  utimesSync(file, newTime, newTime)

  extractIntentForFrame(frame)
  const stats = __getCacheStats()
  assert.equal(stats.misses, 2, "mtime bump should be a fresh miss")
})

test("cache: hit ratio >90% on a 50-call loop with mixed frames", () => {
  __resetCacheForTesting()
  const frames = [
    { file: FIXTURE("handler-with-user-type.ts"), line: 12, function: "handler" },
    { file: FIXTURE("handler-with-nested-type.ts"), line: 18, function: "processOrder" },
    { file: FIXTURE("handler-with-zod.ts"), line: 22, function: "handler" },
    { file: FIXTURE("handler-with-zod-nested.ts"), line: 16, function: "processOrder" },
  ]
  // Prime once per frame (4 cold misses).
  for (const f of frames) extractIntentForFrame(f)

  // Now hammer 50 random hits.
  for (let i = 0; i < 50; i++) {
    extractIntentForFrame(frames[i % frames.length])
  }
  const ratio = __cacheHitRatio()
  assert.ok(
    ratio > 0.9,
    `expected hit ratio > 0.90, got ${ratio.toFixed(3)} (stats=${JSON.stringify(__getCacheStats())})`,
  )
})

test("cache: bypassCache: true skips both read and write", () => {
  __resetCacheForTesting()
  const frame = {
    file: FIXTURE("handler-with-user-type.ts"),
    line: 12,
    function: "handler",
  }
  extractIntentForFrame(frame, { bypassCache: true })
  extractIntentForFrame(frame, { bypassCache: true })
  const stats = __getCacheStats()
  assert.equal(stats.hits, 0, "bypassCache must never count a hit")
  assert.equal(stats.size, 0, "bypassCache must never write the cache")
})
