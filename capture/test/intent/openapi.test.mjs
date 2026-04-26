/**
 * Intent compiler — OpenAPI source tests (SKYNET §3 piece 5, Track D, part 2).
 *
 *   - resolves a request body schema by `operationId` match
 *   - resolves a request body schema by inferred path from a Next.js
 *     `app/api/.../[id]/route.ts` file
 *   - falls back to merged path/query parameters when there is no body
 *   - degenerates (no spec, no project root) → []
 */

import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

import {
  extractIntentForFrame,
  __resetCacheForTesting,
  __resetOpenapiCacheForTesting,
} from "../../dist/intent/index.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = (...parts) => join(__dirname, "fixtures", ...parts)

function reset() {
  __resetCacheForTesting()
  __resetOpenapiCacheForTesting()
}

test("openapi source: resolves a request body schema by operationId", () => {
  reset()
  const contracts = extractIntentForFrame({
    file: FIXTURE("openapi-project", "app", "api", "users", "route.ts"),
    line: 4,
    function: "createUser",
  })
  const oa = contracts.find((c) => c.source === "openapi")
  assert.ok(oa, "expected an openapi contract")
  const shape = oa.shape
  assert.equal(shape.type, "object")
  assert.equal(shape._symbol, "createUser")
  assert.equal(shape.properties.email.type, "string")
  assert.equal(shape.properties.email.format, "email")
  assert.equal(shape.properties.role.enum.length, 2)
  assert.deepEqual([...shape.properties.role.enum].sort(), ["admin", "member"])
  assert.equal(shape.properties.tags.type, "array")
  assert.equal(shape.properties.tags.items.type, "string")
  assert.ok(shape.required.includes("email"))
  assert.ok(shape.required.includes("role"))
  assert.ok(!shape.required.includes("age"))
})

test("openapi source: resolves by inferred path from Next.js app router file", () => {
  reset()
  const contracts = extractIntentForFrame({
    file: FIXTURE("openapi-project", "app", "api", "users", "[id]", "route.ts"),
    line: 8,
    function: "PATCH",
  })
  const oa = contracts.find((c) => c.source === "openapi")
  assert.ok(oa, "expected an openapi contract")
  const shape = oa.shape
  assert.equal(shape.type, "object")
  assert.equal(shape.properties.email.type, "string")
  assert.equal(shape.properties.email.format, "email")
  assert.equal(shape.properties.nickname.type, "string")
})

test("openapi source: GET-style operations expose path/query params as object", () => {
  reset()
  const contracts = extractIntentForFrame({
    file: FIXTURE("openapi-project", "app", "api", "users", "[id]", "route.ts"),
    line: 4,
    function: "GET",
  })
  const oa = contracts.find((c) => c.source === "openapi")
  assert.ok(oa, "expected an openapi contract")
  const shape = oa.shape
  assert.equal(shape.type, "object")
  // `id` is a path param (required), `expand` is a query param (optional).
  assert.equal(shape.properties.id.type, "string")
  assert.equal(shape.properties.id.format, "uuid")
  assert.deepEqual(
    [...(shape.properties.expand.enum ?? [])].sort(),
    ["orders", "profile"],
  )
  assert.ok(shape.required.includes("id"))
  assert.ok(!shape.required.includes("expand"))
})

test("openapi source: file outside any spec'd project returns no openapi contract", () => {
  reset()
  const contracts = extractIntentForFrame({
    file: FIXTURE("handler-with-user-type.ts"),
    line: 12,
    function: "handler",
  })
  // capture/ has its own package.json but no openapi.json → no openapi contract.
  const oa = contracts.find((c) => c.source === "openapi")
  assert.equal(oa, undefined)
})
