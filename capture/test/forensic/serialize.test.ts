import test from "node:test"
import assert from "node:assert/strict"
import { serializeValue } from "../dist/serialize.js"
import { DEFAULT_OPTIONS } from "../dist/types.js"

const OPTS = DEFAULT_OPTIONS

test("primitives: string, number, boolean", () => {
  assert.equal(serializeValue("s", "hi", OPTS).repr, '"hi"')
  assert.equal(serializeValue("n", 42, OPTS).repr, "42")
  assert.equal(serializeValue("b", true, OPTS).repr, "true")
  assert.equal(serializeValue("u", undefined, OPTS).kind, "undefined")
  assert.equal(serializeValue("nil", null, OPTS).kind, "null")
})

test("bigint is stringified with n suffix", () => {
  const v = serializeValue("big", 2n ** 64n, OPTS)
  assert.ok(v.repr.endsWith("n"))
  assert.equal(v.kind, "bigint")
})

test("flat object preview", () => {
  const v = serializeValue("o", { a: 1, b: "two" }, OPTS)
  assert.equal(v.kind, "object:Object")
  assert.match(v.repr, /"a":1/)
  assert.match(v.repr, /"b":"two"/)
})

test("depth cap kicks in", () => {
  const nested = { a: { b: { c: { d: 1 } } } }
  const v = serializeValue("nested", nested, { ...OPTS, maxValueDepth: 1 })
  assert.ok(v.repr.includes("[Object]") || v.truncated === true)
})

test("cycles are detected and marked", () => {
  const a: Record<string, unknown> = { name: "a" }
  a.self = a
  const v = serializeValue("cycle", a, OPTS)
  assert.match(v.repr, /\[Circular\]/)
})

test("Error gets special kind", () => {
  const v = serializeValue("err", new TypeError("boom"), OPTS)
  assert.equal(v.kind, "error")
  assert.match(v.repr, /TypeError: boom/)
})

test("byte budget truncates strings and marks truncated", () => {
  const v = serializeValue("s", "x".repeat(10_000), { ...OPTS, maxValueBytes: 64 })
  assert.equal(v.truncated, true)
  assert.ok(v.repr.length <= 64)
})

test("array preview respects budget", () => {
  const arr = Array.from({ length: 1000 }, (_, i) => i)
  const v = serializeValue("arr", arr, { ...OPTS, maxValueBytes: 64 })
  assert.equal(v.kind, "array")
  assert.equal(v.truncated, true)
})

test("function gets name", () => {
  const v = serializeValue("f", function named() {}, OPTS)
  assert.equal(v.kind, "function")
  assert.match(v.repr, /named/)
})

test("RegExp and Date have dedicated kinds", () => {
  assert.equal(serializeValue("r", /abc/gi, OPTS).kind, "object:RegExp")
  assert.equal(serializeValue("d", new Date(0), OPTS).kind, "object:Date")
})

test("Promise is detected without awaiting", () => {
  const v = serializeValue("p", Promise.resolve(1), OPTS)
  assert.equal(v.kind, "promise")
})
