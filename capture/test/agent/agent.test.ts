import test from "node:test"
import assert from "node:assert/strict"
import {
  PeerAgent,
  peerAgentIntegration,
  getLocalsAtFrame,
  evaluateInFrame,
  matchFingerprint,
  diffSinceDeploy,
  TOOL_SCHEMAS,
} from "../dist/index.js"

/**
 * Tests for @inariwatch/capture-agent.
 * Spec: CAPTURE_V2_IMPLEMENTATION.md Q5.3.
 *
 * No real OpenAI calls — every test stubs `globalThis.fetch`. This is a
 * unit-test boundary: we verify the agent loop correctly drives the model
 * via tool_calls, parses hypotheses, respects the deadline, and never
 * throws. Real model behavior is verified out-of-band against
 * `eval-report.json`.
 */

// ── Fixtures ──────────────────────────────────────────────────────────────

function baseEvent() {
  return {
    fingerprint: "fp-test-1",
    title: "TypeError: Cannot read properties of undefined (reading 'id')",
    body: "TypeError\n    at handler (/app/api/foo.ts:12:8)",
    severity: "critical" as const,
    timestamp: "2026-04-24T00:00:00.000Z",
    git: {
      commit: "abc123",
      branch: "main",
      message: "fix: handle null user",
      timestamp: "2026-04-23T00:00:00.000Z",
      dirty: false,
    },
    forensics: {
      locals: {
        "0": {
          user: { type: "primitive" as const, value: null },
        },
      },
    },
    runtimeSnap: { heapMb: 100, rssMb: 200, eventloopP99Ms: 5, openHandles: 10 },
  }
}

function mockFetchOnce(responseBody: unknown, status = 200) {
  // @ts-expect-error — patching global is the simplest mock surface
  globalThis.fetch = async () =>
    new Response(JSON.stringify(responseBody), {
      status,
      headers: { "content-type": "application/json" },
    })
}

function mockFetchSequence(responses: unknown[]) {
  let i = 0
  // @ts-expect-error — patching global
  globalThis.fetch = async () => {
    const body = responses[i++] ?? responses[responses.length - 1]
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
}

// ── Tools ─────────────────────────────────────────────────────────────────

test("tool: getLocalsAtFrame returns frame 0 locals", () => {
  const event = baseEvent()
  const result = getLocalsAtFrame(event, 0)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.frameIndex, 0)
    assert.ok(result.locals.user)
  }
})

test("tool: getLocalsAtFrame returns error for missing frame", () => {
  const event = baseEvent()
  const result = getLocalsAtFrame(event, 99)
  assert.equal(result.ok, false)
})

test("tool: evaluateInFrame returns structured 'unsupported' (v0.1)", () => {
  const event = baseEvent()
  const result = evaluateInFrame(event, 0, "user.id")
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /not yet wired/)
})

test("tool: matchFingerprint surfaces existing fleetMatch", () => {
  const event = { ...baseEvent(), fleetMatch: { bloomHit: true, communityFixId: "fix-1", teamsHit: 7 } }
  const result = matchFingerprint(event, event.fingerprint)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.ok(result.match)
    assert.equal(result.match!.bloomHit, true)
    assert.equal(result.match!.teamsHit, 7)
  }
})

test("tool: matchFingerprint returns null when no fleetMatch", () => {
  const event = baseEvent()
  const result = matchFingerprint(event, event.fingerprint)
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.match, null)
})

test("tool: diffSinceDeploy returns unknown when prior SHA env unset", () => {
  delete process.env.INARIWATCH_PRIOR_DEPLOY_SHA
  const event = baseEvent()
  const result = diffSinceDeploy(event)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.fromSha, "abc123")
    assert.equal(result.toSha, null)
  }
})

test("tool: diffSinceDeploy returns SHA range when env set", () => {
  process.env.INARIWATCH_PRIOR_DEPLOY_SHA = "ddd456"
  try {
    const event = baseEvent()
    const result = diffSinceDeploy(event)
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.fromSha, "abc123")
      assert.equal(result.toSha, "ddd456")
    }
  } finally {
    delete process.env.INARIWATCH_PRIOR_DEPLOY_SHA
  }
})

test("tool schemas: 4 tools registered with required fields", () => {
  assert.equal(TOOL_SCHEMAS.length, 4)
  for (const schema of TOOL_SCHEMAS) {
    assert.ok(schema.name)
    assert.ok(schema.description)
    assert.equal(schema.parameters.type, "object")
  }
})

// ── PeerAgent ─────────────────────────────────────────────────────────────

test("PeerAgent.diagnose: parses single-shot stop response", async () => {
  mockFetchOnce({
    id: "test-1",
    model: "gpt-5.4",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: JSON.stringify([
            {
              text: "user is null because session.user.id is undefined after sign-out",
              prior: 0.8,
              cites: ["evidence.stack.0.locals.user"],
              confidence: 0.7,
              source: "local_agent",
            },
          ]),
        },
      },
    ],
  })

  const agent = new PeerAgent({ apiKey: "sk-test" })
  const hypotheses = await agent.diagnose(baseEvent())
  assert.equal(hypotheses.length, 1)
  assert.equal(hypotheses[0]!.source, "local_agent")
  assert.ok(hypotheses[0]!.text.includes("user is null"))
})

test("PeerAgent.diagnose: drives a tool call then parses final hypotheses", async () => {
  mockFetchSequence([
    // Iter 1: model asks for locals
    {
      id: "test-2a",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "getLocalsAtFrame", arguments: JSON.stringify({ frameIndex: 0 }) },
              },
            ],
          },
        },
      ],
    },
    // Iter 2: model returns hypotheses
    {
      id: "test-2b",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: JSON.stringify([
              { text: "x", prior: 0.5, cites: [], confidence: 0.5, source: "local_agent" },
            ]),
          },
        },
      ],
    },
  ])

  const agent = new PeerAgent({ apiKey: "sk-test" })
  const hypotheses = await agent.diagnose(baseEvent())
  assert.equal(hypotheses.length, 1)
})

test("PeerAgent.diagnose: returns [] on HTTP error (never throws)", async () => {
  mockFetchOnce({ error: "boom" }, 500)
  const agent = new PeerAgent({ apiKey: "sk-test" })
  const hypotheses = await agent.diagnose(baseEvent())
  assert.deepEqual(hypotheses, [])
})

test("PeerAgent.diagnose: returns [] on malformed JSON content", async () => {
  mockFetchOnce({
    id: "x",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "I think the bug is in handler()" },
      },
    ],
  })
  const agent = new PeerAgent({ apiKey: "sk-test" })
  const hypotheses = await agent.diagnose(baseEvent())
  assert.deepEqual(hypotheses, [])
})

test("PeerAgent.diagnose: tolerates ```json fenced output", async () => {
  mockFetchOnce({
    id: "x",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content:
            "```json\n[{\"text\":\"x\",\"prior\":0.5,\"cites\":[],\"confidence\":0.5,\"source\":\"local_agent\"}]\n```",
        },
      },
    ],
  })
  const agent = new PeerAgent({ apiKey: "sk-test" })
  const hypotheses = await agent.diagnose(baseEvent())
  assert.equal(hypotheses.length, 1)
})

test("PeerAgent.diagnose: caps to 3 hypotheses even if model returns more", async () => {
  mockFetchOnce({
    id: "x",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: JSON.stringify(
            Array.from({ length: 10 }, (_, i) => ({
              text: `h${i}`,
              prior: 0.5,
              cites: [],
              confidence: 0.5,
              source: "local_agent",
            })),
          ),
        },
      },
    ],
  })
  const agent = new PeerAgent({ apiKey: "sk-test" })
  const hypotheses = await agent.diagnose(baseEvent())
  assert.equal(hypotheses.length, 3)
})

test("PeerAgent.diagnose: clamps prior/confidence to 0..1", async () => {
  mockFetchOnce({
    id: "x",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: JSON.stringify([
            { text: "x", prior: 5, cites: [], confidence: -1, source: "local_agent" },
          ]),
        },
      },
    ],
  })
  const agent = new PeerAgent({ apiKey: "sk-test" })
  const hypotheses = await agent.diagnose(baseEvent())
  assert.equal(hypotheses.length, 1)
  assert.equal(hypotheses[0]!.prior, 1)
  assert.equal(hypotheses[0]!.confidence, 0)
})

// ── peerAgentIntegration ──────────────────────────────────────────────────

test("integration: name matches and onBeforeSend is async", () => {
  const integ = peerAgentIntegration({ apiKey: "sk-test" })
  assert.equal(integ.name, "@inariwatch/capture-agent")
  assert.equal(typeof integ.setup, "function")
  assert.equal(typeof integ.onBeforeSend, "function")
})

test("integration: missing apiKey disables silently (no throw on setup)", () => {
  const integ = peerAgentIntegration({ apiKey: "" })
  assert.doesNotThrow(() => integ.setup({}))
})

test("integration: env INARIWATCH_PEER_AGENT_DISABLED short-circuits", async () => {
  process.env.INARIWATCH_PEER_AGENT_DISABLED = "true"
  try {
    const integ = peerAgentIntegration({ apiKey: "sk-test" })
    integ.setup({})
    const event = baseEvent()
    const out = await integ.onBeforeSend!(event)
    assert.equal(out, event) // exact same reference — pass-through
  } finally {
    delete process.env.INARIWATCH_PEER_AGENT_DISABLED
  }
})

test("integration: skips events whose severity is below minSeverity", async () => {
  // With default minSeverity=warning, an "info" event passes through unchanged.
  const integ = peerAgentIntegration({ apiKey: "sk-test" })
  integ.setup({})
  const event = { ...baseEvent(), severity: "info" as const }
  const out = await integ.onBeforeSend!(event)
  assert.equal(out, event)
})

test("integration: skips events that already have hypotheses", async () => {
  const integ = peerAgentIntegration({ apiKey: "sk-test" })
  integ.setup({})
  const event = {
    ...baseEvent(),
    hypotheses: [
      { text: "preexisting", prior: 0.9, cites: [], confidence: 0.9, source: "bloom_match" as const },
    ],
  }
  const out = await integ.onBeforeSend!(event)
  assert.equal(out, event)
})

test("integration: attaches hypotheses on success", async () => {
  mockFetchOnce({
    id: "x",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: JSON.stringify([
            { text: "ok", prior: 0.5, cites: [], confidence: 0.5, source: "local_agent" },
          ]),
        },
      },
    ],
  })

  const integ = peerAgentIntegration({ apiKey: "sk-test" })
  integ.setup({})
  const event = baseEvent()
  const out = await integ.onBeforeSend!(event)
  assert.notEqual(out, null)
  assert.equal(out!.hypotheses?.length, 1)
  assert.equal(out!.schemaVersion, "2.0")
  // Original event wasn't mutated
  assert.equal(event.hypotheses, undefined)
})

test("integration: NEVER drops the event — returns event on diagnose failure", async () => {
  mockFetchOnce({ error: "boom" }, 500)
  const integ = peerAgentIntegration({ apiKey: "sk-test" })
  integ.setup({})
  const event = baseEvent()
  const out = await integ.onBeforeSend!(event)
  assert.notEqual(out, null)
  // Hypotheses field absent because diagnose returned []
  assert.equal(out!.hypotheses, undefined)
})
