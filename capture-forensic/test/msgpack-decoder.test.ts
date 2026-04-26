import test from "node:test"
import assert from "node:assert/strict"
import { decode, decodeForensicPayload } from "../dist/msgpack-decoder.js"

/**
 * These tests pin the decoder to the EXACT byte emission of
 * `v8::internal::forensics::MsgpackEncoder`. If the C++ encoder changes,
 * these tests must change in lockstep.
 */

function bytes(...xs: number[]): Uint8Array {
  return new Uint8Array(xs)
}

test("fixints", () => {
  assert.equal(decode(bytes(0x00)), 0)
  assert.equal(decode(bytes(0x7f)), 127)
  assert.equal(decode(bytes(0xff)), -1)
  assert.equal(decode(bytes(0xe0)), -32)
})

test("uint8/16/32", () => {
  assert.equal(decode(bytes(0xcc, 0x80)), 128)
  assert.equal(decode(bytes(0xcd, 0x01, 0x00)), 256)
  assert.equal(decode(bytes(0xce, 0x00, 0x01, 0x00, 0x00)), 65536)
})

test("int8/16/32", () => {
  assert.equal(decode(bytes(0xd0, 0x80)), -128)
  assert.equal(decode(bytes(0xd1, 0x80, 0x00)), -32768)
  assert.equal(decode(bytes(0xd2, 0x80, 0x00, 0x00, 0x00)), -2147483648)
})

test("fixstr / str8 / str16", () => {
  assert.equal(decode(bytes(0xa3, 0x66, 0x6f, 0x6f)), "foo")
  const long = "x".repeat(40)
  const utf = new TextEncoder().encode(long)
  assert.equal(decode(new Uint8Array([0xd9, utf.length, ...utf])), long)
})

test("fixarr of ints", () => {
  assert.deepEqual(decode(bytes(0x93, 0x01, 0x02, 0x03)), [1, 2, 3])
})

test("fixmap with string keys", () => {
  const b = bytes(
    0x82,                              // fixmap size=2
    0xa1, 0x61, 0x01,                  // "a": 1
    0xa1, 0x62, 0xa3, 0x62, 0x61, 0x72, // "b": "bar"
  )
  assert.deepEqual(decode(b), { a: 1, b: "bar" })
})

test("bool + nil", () => {
  assert.equal(decode(bytes(0xc0)), null)
  assert.equal(decode(bytes(0xc2)), false)
  assert.equal(decode(bytes(0xc3)), true)
})

test("decodeForensicPayload on a hand-crafted capture", () => {
  // Mirror of what v8::internal::forensics::MsgpackEncoder would emit for
  // a single frame with one local (name=answer, repr=42, kind=number,
  // truncated=false).
  const p = bytes(
    0x82,                                                 // outer map {v, frames}: size=2
    0xa1, 0x76,                                           // "v"
    0x01,                                                 //   1
    0xa6, 0x66, 0x72, 0x61, 0x6d, 0x65, 0x73,             // "frames"
    0x91,                                                 //   arr size=1
    0x88,                                                 //     frame map size=8 (no receiver)
    0xa5, 0x69, 0x6e, 0x64, 0x65, 0x78, 0x00,             //       "index": 0
    0xac, 0x66, 0x75, 0x6e, 0x63, 0x74, 0x69, 0x6f, 0x6e, 0x4e, 0x61, 0x6d, 0x65,
    0xaa, 0x74, 0x68, 0x72, 0x6f, 0x77, 0x69, 0x6e, 0x67, 0x46, 0x6e,   //       "functionName": "throwingFn"
    0xa9, 0x73, 0x6f, 0x75, 0x72, 0x63, 0x65, 0x55, 0x72, 0x6c,
    0xa0,                                                                //       "sourceUrl": ""
    0xa4, 0x6c, 0x69, 0x6e, 0x65, 0x19,                                  //       "line": 25
    0xa3, 0x63, 0x6f, 0x6c, 0x03,                                        //       "col": 3
    0xa6, 0x6c, 0x6f, 0x63, 0x61, 0x6c, 0x73,                            //       "locals"
    0x91,                                                                 //         arr size=1
    0x84,                                                                 //           value map size=4
    0xa4, 0x6e, 0x61, 0x6d, 0x65,                                         //             "name"
    0xa6, 0x61, 0x6e, 0x73, 0x77, 0x65, 0x72,                             //             "answer"
    0xa4, 0x72, 0x65, 0x70, 0x72,                                         //             "repr"
    0xa2, 0x34, 0x32,                                                     //             "42"
    0xa4, 0x6b, 0x69, 0x6e, 0x64,                                         //             "kind"
    0xa6, 0x6e, 0x75, 0x6d, 0x62, 0x65, 0x72,                             //             "number"
    0xa9, 0x74, 0x72, 0x75, 0x6e, 0x63, 0x61, 0x74, 0x65, 0x64,           //             "truncated"
    0xc2,                                                                 //             false
    0xa7, 0x63, 0x6c, 0x6f, 0x73, 0x75, 0x72, 0x65,                       //       "closure"
    0x90,                                                                 //         arr size=0
    0xa7, 0x70, 0x61, 0x72, 0x74, 0x69, 0x61, 0x6c,                       //       "partial"
    0xc2,                                                                 //         false
  )
  const out = decodeForensicPayload(p)
  assert.equal(out.version, 1)
  assert.equal(out.frames.length, 1)
  const f = out.frames[0]!
  assert.equal(f.functionName, "throwingFn")
  assert.equal(f.line, 25)
  assert.equal(f.column, 3)
  assert.equal(f.locals.length, 1)
  assert.equal(f.locals[0]!.name, "answer")
  assert.equal(f.locals[0]!.repr, "42")
  assert.equal(f.locals[0]!.kind, "number")
  assert.equal(f.locals[0]!.truncated, undefined)
  assert.equal(f.closure.length, 0)
  assert.equal(f.partial, undefined)
  assert.equal(f.receiver, undefined)
})

test("decoder rejects truncated payload", () => {
  assert.throws(() => decode(bytes(0xcd, 0x01)), /truncated/)
})

test("decoder rejects unknown type byte", () => {
  assert.throws(() => decode(bytes(0xc1)), /unsupported/)
})
