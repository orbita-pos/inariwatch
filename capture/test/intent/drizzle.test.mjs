/**
 * Intent compiler — Drizzle source tests (SKYNET §3 piece 5, Track D, part 2).
 *
 *   - extracts `users` table shape with `notNull()` → required, default → not required
 *   - resolves a function symbol (`createUser`) by following `db.insert(users)`
 *   - falls back to first declared table when symbol is unknown
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

test("drizzle source: extracts table shape with required/optional from notNull/default", () => {
  __resetCacheForTesting()
  const contracts = extractIntentForFrame({
    file: FIXTURE("drizzle-schema.ts"),
    line: 1,
    function: "users",
  })
  const dz = contracts.find((c) => c.source === "drizzle")
  assert.ok(dz, "expected a drizzle contract")
  const shape = dz.shape
  assert.equal(shape.type, "object")
  assert.equal(shape._symbol, "users")
  assert.equal(shape.properties.id.type, "string")
  assert.equal(shape.properties.id.format, "uuid")
  assert.equal(shape.properties.email.type, "string")
  assert.equal(shape.properties.nickname.type, "string")
  assert.equal(shape.properties.age.type, "number")
  assert.equal(shape.properties.isActive.type, "boolean")
  assert.equal(shape.properties.createdAt.type, "string")
  assert.equal(shape.properties.createdAt.format, "date-time")

  // primaryKey + notNull → required; nullable → not required;
  // notNull + default → not required (DB fills it in).
  assert.ok(shape.required.includes("id"))
  assert.ok(shape.required.includes("email"))
  assert.ok(!shape.required.includes("nickname"))
  assert.ok(!shape.required.includes("age"))
  assert.ok(!shape.required.includes("isActive"), "isActive has default → not required")
  assert.ok(!shape.required.includes("createdAt"), "createdAt has defaultNow → not required")
})

test("drizzle source: handles array() column modifier", () => {
  __resetCacheForTesting()
  const contracts = extractIntentForFrame({
    file: FIXTURE("drizzle-schema.ts"),
    line: 1,
    function: "orders",
  })
  const dz = contracts.find((c) => c.source === "drizzle")
  assert.ok(dz)
  const shape = dz.shape
  assert.equal(shape._symbol, "orders")
  assert.equal(shape.properties.tags.type, "array")
  assert.equal(shape.properties.tags.items.type, "string")
})

test("drizzle source: function symbol resolves via db.insert(users)", () => {
  __resetCacheForTesting()
  const contracts = extractIntentForFrame({
    file: FIXTURE("drizzle-schema.ts"),
    line: 28,
    function: "createUser",
  })
  const dz = contracts.find((c) => c.source === "drizzle")
  assert.ok(dz, "expected a drizzle contract for createUser")
  assert.equal(dz.shape._symbol, "users")
})

test("drizzle source: file without drizzle import is silently skipped", () => {
  __resetCacheForTesting()
  const contracts = extractIntentForFrame({
    file: FIXTURE("handler-with-user-type.ts"),
    line: 12,
    function: "handler",
  })
  assert.equal(contracts.find((c) => c.source === "drizzle"), undefined)
})
