/**
 * Intent compiler — GraphQL source tests (SKYNET §3 piece 5, Track D, part 3).
 *
 *   - resolves an Input type by direct symbol match
 *   - resolves a Mutation field's args by symbol match (`createUser`)
 *   - falls back to first Input type when no match
 *   - degenerates (no schema files / no peer) → no graphql contract
 *
 * The `graphql` package is an OPTIONAL peer (mirrors `yaml` for OpenAPI):
 * when it isn't installed we skip the deep assertions and verify only
 * the degradation path. Tests stay green either way so the CI matrix
 * doesn't have to special-case the SDK's optional deps.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { createRequire } from "node:module"

import {
  extractIntentForFrame,
  __resetCacheForTesting,
  __resetGraphqlCacheForTesting,
} from "../../dist/intent/index.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = (...parts) => join(__dirname, "fixtures", ...parts)

const require_ = createRequire(import.meta.url)
let HAS_GRAPHQL = false
try {
  const mod = require_("graphql")
  HAS_GRAPHQL = typeof mod?.parse === "function"
} catch {
  HAS_GRAPHQL = false
}

function reset() {
  __resetCacheForTesting()
  __resetGraphqlCacheForTesting()
}

test("graphql source: resolves an Input type by direct symbol", { skip: !HAS_GRAPHQL && "graphql peer not installed" }, () => {
  reset()
  const contracts = extractIntentForFrame({
    file: FIXTURE("graphql-project", "resolvers", "createUser.ts"),
    line: 4,
    function: "CreateUserInput",
  })
  const gql = contracts.find((c) => c.source === "graphql")
  assert.ok(gql, "expected a graphql contract")
  const shape = gql.shape
  assert.equal(shape.type, "object")
  assert.equal(shape._symbol, "CreateUserInput")
  assert.equal(shape.properties.email.type, "string")
  assert.equal(shape.properties.age.type, "number")
  assert.deepEqual(
    [...(shape.properties.role.enum ?? [])].sort(),
    ["ADMIN", "MEMBER"],
  )
  assert.equal(shape.properties.tags.type, "array")
  assert.equal(shape.properties.tags.items.type, "string")
  assert.ok(shape.required.includes("email"))
  assert.ok(shape.required.includes("role"))
  assert.ok(!shape.required.includes("age"))
  assert.ok(!shape.required.includes("tags"))
})

test("graphql source: resolves a Mutation field args by symbol", { skip: !HAS_GRAPHQL && "graphql peer not installed" }, () => {
  reset()
  const contracts = extractIntentForFrame({
    file: FIXTURE("graphql-project", "resolvers", "createUser.ts"),
    line: 4,
    function: "createUser",
  })
  const gql = contracts.find((c) => c.source === "graphql")
  assert.ok(gql, "expected a graphql contract")
  const shape = gql.shape
  assert.equal(shape.type, "object")
  // `createUser(input: CreateUserInput!)` — required arg `input` referencing the type.
  assert.ok(shape.properties.input)
  assert.equal(shape.properties.input.$ref, "CreateUserInput")
  assert.ok((shape.required ?? []).includes("input"))
})

test("graphql source: falls back to first Input type when symbol unknown", { skip: !HAS_GRAPHQL && "graphql peer not installed" }, () => {
  reset()
  const contracts = extractIntentForFrame({
    file: FIXTURE("graphql-project", "resolvers", "createUser.ts"),
    line: 4,
    function: "totallyUnknownSymbol",
  })
  const gql = contracts.find((c) => c.source === "graphql")
  assert.ok(gql, "expected a graphql contract")
  // Fallback prefers the first Input type → CreateUserInput.
  assert.equal(gql.shape._symbol, "CreateUserInput")
})

test("graphql source: file outside any graphql project returns no graphql contract", () => {
  reset()
  const contracts = extractIntentForFrame({
    file: FIXTURE("handler-with-user-type.ts"),
    line: 12,
    function: "handler",
  })
  // capture/ has its own package.json but no *.graphql files → no graphql contract.
  const gql = contracts.find((c) => c.source === "graphql")
  assert.equal(gql, undefined)
})
