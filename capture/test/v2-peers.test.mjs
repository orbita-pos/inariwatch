/**
 * E2E wiring test for the capture v2 peer ecosystem (Track I, SKYNET §3).
 *
 * Verifies that when `init()` receives all three peer integrations, the
 * resulting `ErrorEvent` carries `forensics`, `fleetMatch`, and
 * `hypotheses` after the onBeforeSend chain runs.
 *
 * Run from `capture/`:
 *   npm test                 # builds capture + peers, then runs this file
 *
 * Tests imports use the built `dist/` of each peer (relative paths) — no
 * npm publish step needed.
 */

import test from "node:test"
import assert from "node:assert/strict"

import { init, captureException } from "../dist/index.js"
import { peerAgentIntegration } from "../../capture-agent/dist/index.js"
import { fleetBloomIntegration } from "../../capture-fleet/dist/index.js"
import {
  forensicIntegration,
  __pushCaptureForTesting,
  __resetForensicIntegrationForTesting,
} from "../../capture-forensic/dist/index.js"

const ORIG_FETCH = globalThis.fetch

function installFetchMock() {
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input))
    if (url.includes("/chat/completions")) {
      // Stub OpenAI: return a single ranked hypothesis, finish_reason=stop.
      const body = JSON.stringify({
        id: "test",
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content:
                '[{"text":"NPE in handler","prior":0.7,"cites":["title"],"confidence":0.85,"source":"local_agent"}]',
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      })
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } })
    }
    if (url.includes("/api/fleet/bloom/latest")) {
      // 503 = "no bloom yet" — bloom client logs and returns false on lookups.
      // Critically, the integration still attaches fleetMatch={bloomHit:false}.
      return new Response("", { status: 503 })
    }
    if (url.includes("/api/fleet/bloom/observe")) {
      return new Response("{}", { status: 200 })
    }
    // DSN sink — just succeed.
    return new Response("{}", { status: 200 })
  }
}

function restoreFetch() {
  globalThis.fetch = ORIG_FETCH
}

function makeForensicCapture(stack) {
  const err = new Error("Cannot read property 'x' of undefined")
  err.stack = stack
  return {
    frames: [
      {
        index: 0,
        functionName: "handler",
        sourceUrl: "file:///app/handler.js",
        line: 12,
        column: 5,
        locals: [
          { name: "user", repr: "{ id: 1 }", kind: "object:Object" },
          { name: "tmp", repr: "undefined", kind: "undefined" },
        ],
        closure: [{ name: "ctx", repr: "{ tenantId: 'abc' }", kind: "object:Object" }],
      },
      {
        index: 1,
        functionName: "router",
        line: 40,
        column: 7,
        locals: [{ name: "req", repr: "[Request]", kind: "object", truncated: true }],
        closure: [],
      },
    ],
    error: err,
    pid: process.pid,
    tid: 0,
    tsNs: 0n,
    source: "inspector",
    captureDurationMs: 1,
  }
}

test("v2 peers: forensics + fleetMatch + hypotheses all reach the payload", async () => {
  installFetchMock()
  __resetForensicIntegrationForTesting()

  let resolveEvent
  const captured = new Promise((r) => {
    resolveEvent = r
  })

  init({
    dsn: "https://test:secret@localhost.test/proj1",
    silent: true,
    debug: false,
    fullTrace: false,
    // Drop after capture so we don't actually hit a network sink.
    beforeSend: (event) => {
      resolveEvent(event)
      return null
    },
    integrations: [
      forensicIntegration(),
      fleetBloomIntegration({ baseUrl: "http://fleet.test" }),
      peerAgentIntegration({ apiKey: "stub-openai-key", deadlineMs: 5000 }),
    ],
  })

  // Inject a synthetic forensic capture matching the about-to-throw error.
  const stack = [
    "Error: Cannot read property 'x' of undefined",
    "    at handler (file:///app/handler.js:12:5)",
  ].join("\n")
  __pushCaptureForTesting(makeForensicCapture(stack))

  const e = new Error("Cannot read property 'x' of undefined")
  e.stack = stack
  captureException(e)

  const event = await Promise.race([
    captured,
    new Promise((_, rej) => setTimeout(() => rej(new Error("beforeSend never called")), 5000)),
  ])

  restoreFetch()

  assert.ok(event, "event should reach beforeSend")
  assert.equal(event.title, "Error: Cannot read property 'x' of undefined")

  // forensicIntegration attached forensics
  assert.ok(event.forensics, "event.forensics present")
  assert.ok(event.forensics.locals?.["0"], "frame 0 locals captured")
  assert.equal(event.forensics.locals["0"].user.preview, "{ id: 1 }")
  assert.ok(event.forensics.closureChains?.["0"], "frame 0 closure captured")

  // fleetBloomIntegration attached fleetMatch (bloomHit=false because 503)
  assert.ok(event.fleetMatch, "event.fleetMatch present")
  assert.equal(event.fleetMatch.bloomHit, false)

  // peerAgentIntegration attached hypotheses from the stubbed OpenAI response
  assert.ok(Array.isArray(event.hypotheses), "event.hypotheses is array")
  assert.equal(event.hypotheses.length, 1, "one hypothesis from stub")
  assert.equal(event.hypotheses[0].text, "NPE in handler")
  assert.equal(event.hypotheses[0].source, "local_agent")

  // schemaVersion bumped to 2.0 by integrations that attach v2 fields
  assert.equal(event.schemaVersion, "2.0")
})

test("v2 peers: api unchanged when no integrations passed (backward compat)", async () => {
  installFetchMock()

  let resolveEvent
  const captured = new Promise((r) => {
    resolveEvent = r
  })

  init({
    dsn: "https://test:secret@localhost.test/proj1",
    silent: true,
    fullTrace: false,
    beforeSend: (event) => {
      resolveEvent(event)
      return null
    },
    // No integrations — must keep working exactly as v1.
  })

  captureException(new Error("baseline"))
  const event = await Promise.race([
    captured,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
  ])
  restoreFetch()

  assert.ok(event, "event sent")
  assert.equal(event.forensics, undefined, "no forensics when peer absent")
  assert.equal(event.fleetMatch, undefined, "no fleetMatch when peer absent")
  assert.equal(event.hypotheses, undefined, "no hypotheses when peer absent")
})
