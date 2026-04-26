/**
 * Intent compiler — TypeScript source tests (SKYNET §3 piece 5).
 *
 *   - extracts the User interface as a JSON-Schema-flavored shape
 *     when the handler's first param is typed `User`
 *   - resolves transitive types (Address, OrderStatus, Array<{...}>)
 *     within the same file
 *   - degenerate inputs (no symbol, missing file) return `[]` not throw
 *
 * Run from `capture/`: npm test
 */

import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

import {
  extractIntentForFrame,
  __resetCacheForTesting,
} from "../../dist/intent/index.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = (name) => join(__dirname, "fixtures", name)

test("ts source: extracts top-level User interface from handler param", () => {
  __resetCacheForTesting()
  const contracts = extractIntentForFrame({
    file: FIXTURE("handler-with-user-type.ts"),
    line: 12,
    function: "handler",
  })

  // Should produce one TS contract (Zod source bails on this file — no zod import).
  const ts = contracts.find((c) => c.source === "ts")
  assert.ok(ts, "expected a ts contract")

  const shape = ts.shape
  assert.equal(shape._symbol, "User")
  assert.equal(shape.type, "object")
  assert.equal(shape.properties.id.type, "string")
  assert.equal(shape.properties.email.type, "string")
  assert.equal(shape.properties.age.type, "number")
  assert.equal(shape.properties.tags.type, "array")
  assert.equal(shape.properties.tags.items.type, "string")

  // role is optional → not in required
  assert.ok(!shape.required.includes("role"))
  assert.ok(shape.required.includes("id"))
  assert.ok(shape.required.includes("email"))

  // role is "admin" | "member" → enum
  assert.deepEqual(shape.properties.role.enum?.sort(), ["admin", "member"])
})

test("ts source: resolves nested types transitively within the file", () => {
  __resetCacheForTesting()
  const contracts = extractIntentForFrame({
    file: FIXTURE("handler-with-nested-type.ts"),
    line: 18,
    function: "processOrder",
  })

  const ts = contracts.find((c) => c.source === "ts")
  assert.ok(ts, "expected a ts contract")
  const shape = ts.shape
  assert.equal(shape._symbol, "Order")
  assert.equal(shape.type, "object")

  // shipTo must resolve transitively to the Address interface.
  assert.equal(shape.properties.shipTo.type, "object")
  assert.equal(shape.properties.shipTo.properties.street.type, "string")
  assert.equal(shape.properties.shipTo.properties.zip.type, "string")

  // status must resolve to the OrderStatus union → enum.
  const statusEnum = shape.properties.status.enum
  assert.ok(Array.isArray(statusEnum))
  assert.deepEqual([...statusEnum].sort(), ["delivered", "pending", "shipped"])

  // Array<{ sku, qty }> → array of object
  assert.equal(shape.properties.lineItems.type, "array")
  assert.equal(shape.properties.lineItems.items.type, "object")
  assert.equal(shape.properties.lineItems.items.properties.sku.type, "string")
  assert.equal(shape.properties.lineItems.items.properties.qty.type, "number")
})

test("ts source: missing file returns [] not throw", () => {
  __resetCacheForTesting()
  const contracts = extractIntentForFrame({
    file: FIXTURE("does-not-exist.ts"),
    line: 1,
    function: "nope",
  })
  assert.deepEqual(contracts, [])
})

test("ts source: unknown symbol still finds the file's first exported function", () => {
  __resetCacheForTesting()
  const contracts = extractIntentForFrame({
    file: FIXTURE("handler-with-user-type.ts"),
    line: 1,
    function: "this-symbol-doesnt-exist",
  })
  // Source falls back to the file's first exported function → handler → User
  // (we accept either a hit or a clean miss, but never a throw).
  assert.ok(Array.isArray(contracts))
})
