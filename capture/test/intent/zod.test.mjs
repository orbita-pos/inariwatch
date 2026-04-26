/**
 * Intent compiler — Zod source tests (SKYNET §3 piece 5).
 *
 *   - extracts shape from `userSchema = z.object({...})` referenced by
 *     `userSchema.parse(req.body)` inside the handler
 *   - chained refinements: `.email()`, `.uuid()`, `.int()`, `.optional()`
 *   - nested + cross-reference: orderSchema → addressSchema
 *   - degenerates → []
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

test("zod source: extracts shape from schema referenced via .parse()", () => {
  __resetCacheForTesting()
  const contracts = extractIntentForFrame({
    file: FIXTURE("handler-with-zod.ts"),
    line: 22,
    function: "handler",
  })

  const zod = contracts.find((c) => c.source === "zod")
  assert.ok(zod, "expected a zod contract")
  const shape = zod.shape
  assert.equal(shape._symbol, "userSchema")
  assert.equal(shape.type, "object")

  assert.equal(shape.properties.id.type, "string")
  assert.equal(shape.properties.id.format, "uuid")
  assert.equal(shape.properties.email.type, "string")
  assert.equal(shape.properties.email.format, "email")
  assert.equal(shape.properties.age.type, "number")
  assert.equal(shape.properties.isActive.type, "boolean")
  assert.equal(shape.properties.tags.type, "array")
  assert.equal(shape.properties.tags.items.type, "string")

  // Enum collapsed from union of literals
  assert.deepEqual(
    [...(shape.properties.role.enum ?? [])].sort(),
    ["admin", "member"],
  )

  // .optional() ⇒ not in required
  assert.ok(!shape.required.includes("nickname"))
  assert.ok(shape.required.includes("id"))
})

test("zod source: cross-references another schema declared in the same file", () => {
  __resetCacheForTesting()
  const contracts = extractIntentForFrame({
    file: FIXTURE("handler-with-zod-nested.ts"),
    line: 16,
    function: "processOrder",
  })

  const zod = contracts.find((c) => c.source === "zod")
  assert.ok(zod, "expected a zod contract")
  const shape = zod.shape
  assert.equal(shape._symbol, "orderSchema")

  // shipTo must resolve to the addressSchema variable.
  assert.equal(shape.properties.shipTo.type, "object")
  assert.equal(shape.properties.shipTo.properties.street.type, "string")
  assert.equal(shape.properties.shipTo.properties.city.type, "string")

  // union of literals collapses to enum
  assert.deepEqual(
    [...(shape.properties.status.enum ?? [])].sort(),
    ["pending", "shipped"],
  )
})

test("zod source: file without zod is silently skipped", () => {
  __resetCacheForTesting()
  const contracts = extractIntentForFrame({
    file: FIXTURE("handler-with-user-type.ts"),
    line: 12,
    function: "handler",
  })
  assert.equal(contracts.find((c) => c.source === "zod"), undefined)
})
