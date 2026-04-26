/**
 * Intent compiler — Prisma source tests (SKYNET §3 piece 5, Track D, part 2).
 *
 *   - resolves a model by exact name match
 *   - resolves a model by case-insensitive + verb-stripped match
 *     (`getUser` → `User`)
 *   - enums become `enum:` lists
 *   - relation fields are not in `required` (resolved at query time)
 *   - falls back to first model when symbol is unknown
 */

import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

import {
  extractIntentForFrame,
  __resetCacheForTesting,
  __resetPrismaCacheForTesting,
} from "../../dist/intent/index.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = (...parts) => join(__dirname, "fixtures", ...parts)

function reset() {
  __resetCacheForTesting()
  __resetPrismaCacheForTesting()
}

test("prisma source: resolves a model by exact name", () => {
  reset()
  const contracts = extractIntentForFrame({
    file: FIXTURE("prisma-project", "app", "api", "users", "route.ts"),
    line: 5,
    function: "User",
  })
  const pr = contracts.find((c) => c.source === "prisma")
  assert.ok(pr, "expected a prisma contract")
  const shape = pr.shape
  assert.equal(shape.type, "object")
  assert.equal(shape._symbol, "User")

  // Scalars
  assert.equal(shape.properties.id.type, "string")
  assert.equal(shape.properties.email.type, "string")
  assert.equal(shape.properties.age.type, "number")
  assert.equal(shape.properties.isActive.type, "boolean")
  assert.equal(shape.properties.createdAt.type, "string")
  assert.equal(shape.properties.createdAt.format, "date-time")

  // Enum
  assert.equal(shape.properties.role.type, "string")
  assert.deepEqual(
    [...(shape.properties.role.enum ?? [])].sort(),
    ["ADMIN", "GUEST", "MEMBER"],
  )

  // id has @default(uuid()) → not required
  assert.ok(!shape.required.includes("id"))
  // email has no default and is not optional → required
  assert.ok(shape.required.includes("email"))
  // role has @default(MEMBER) → not required
  assert.ok(!shape.required.includes("role"))
  // age is `Int?` → not required
  assert.ok(!shape.required.includes("age"))
  // updatedAt has @updatedAt → not required
  assert.ok(!shape.required.includes("updatedAt"))
  // orders is a relation field → not required
  assert.ok(!shape.required.includes("orders"))
})

test("prisma source: resolves `getUser` via verb-stripped match", () => {
  reset()
  const contracts = extractIntentForFrame({
    file: FIXTURE("prisma-project", "app", "api", "users", "route.ts"),
    line: 9,
    function: "getUser",
  })
  const pr = contracts.find((c) => c.source === "prisma")
  assert.ok(pr, "expected a prisma contract")
  assert.equal(pr.shape._symbol, "User")
})

test("prisma source: resolves `createOrders` via verb-stripped + singularize", () => {
  reset()
  const contracts = extractIntentForFrame({
    file: FIXTURE("prisma-project", "app", "api", "users", "route.ts"),
    line: 1,
    function: "createOrders",
  })
  const pr = contracts.find((c) => c.source === "prisma")
  assert.ok(pr)
  assert.equal(pr.shape._symbol, "Order")
})

test("prisma source: array fields become array shapes", () => {
  reset()
  const contracts = extractIntentForFrame({
    file: FIXTURE("prisma-project", "app", "api", "users", "route.ts"),
    line: 1,
    function: "Order",
  })
  const pr = contracts.find((c) => c.source === "prisma")
  assert.ok(pr)
  assert.equal(pr.shape.properties.tags.type, "array")
  assert.equal(pr.shape.properties.tags.items.type, "string")
  // userId is required (not optional, no default, scalar)
  assert.ok(pr.shape.required.includes("userId"))
  // user is a relation field → not required
  assert.ok(!pr.shape.required.includes("user"))
})

test("prisma source: file outside any prisma project returns no prisma contract", () => {
  reset()
  const contracts = extractIntentForFrame({
    file: FIXTURE("handler-with-user-type.ts"),
    line: 12,
    function: "User",
  })
  assert.equal(contracts.find((c) => c.source === "prisma"), undefined)
})
