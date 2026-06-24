/**
 * Project-token mode tests (Inari Live V1 — Session 2).
 *
 * Covers:
 *   - parseDSN recognises the `iwk_pub_v1_…` prefix and reports authMode="token"
 *   - parseDSN keeps backwards compat for legacy DSNs (authMode="hmac")
 *   - parseToken builds the same wire shape from a bare token + projectId
 *   - parseToken rejects non-token strings and invalid projectIds
 *   - The transport sends `Authorization: Bearer …` for token mode and
 *     omits the legacy `x-capture-signature` header
 *   - The transport keeps signing the body with HMAC for legacy DSN mode
 *
 * Uses Node's built-in test runner — matches the rest of capture/test/.
 *   npm test
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  parseDSN,
  parseToken,
  isProjectToken,
  PROJECT_TOKEN_PREFIX,
  createTransport,
} from "../dist/transport.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

const PROJECT_ID = "11111111-2222-3333-4444-555555555555"
const TOKEN = `${PROJECT_TOKEN_PREFIX}aB3xY9k_thisIsAFakeButLongEnoughTokenBody123`
const LEGACY_SECRET = "deadbeefdeadbeefdeadbeefdeadbeef"

function makeFetchSpy(status = 200) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ ok: true }), {
      status,
      headers: { "content-type": "application/json" },
    })
  }
  return calls
}

function restoreFetch() {
  // node 18+ has fetch globally — we replaced it with our spy. Setting to
  // undefined would break later tests, so re-import the global default by
  // deleting the property first.
  delete globalThis.fetch
}

// ── isProjectToken ───────────────────────────────────────────────────────────

test("isProjectToken: matches iwk_pub_v1_ prefix", () => {
  assert.equal(isProjectToken(TOKEN), true)
})

test("isProjectToken: rejects null / empty / random", () => {
  assert.equal(isProjectToken(null), false)
  assert.equal(isProjectToken(undefined), false)
  assert.equal(isProjectToken(""), false)
  assert.equal(isProjectToken("notatoken"), false)
  assert.equal(isProjectToken("Bearer iwk_pub_v1_x"), false)
})

test("isProjectToken: rejects look-alike prefixes", () => {
  assert.equal(isProjectToken("iwk_pub_v2_xxx"), false)
  assert.equal(isProjectToken("iwk_pub_v1xxx"), false)
})

// ── parseDSN: token mode ────────────────────────────────────────────────────

test("parseDSN: token-mode DSN extracts the token as secretKey, authMode=token", () => {
  const dsn = `https://${TOKEN}@app.inariwatch.com/capture/${PROJECT_ID}`
  const parsed = parseDSN(dsn)
  assert.equal(parsed.secretKey, TOKEN)
  assert.equal(parsed.isLocal, false)
  assert.equal(parsed.authMode, "token")
  assert.match(parsed.endpoint, /\/api\/webhooks\/capture\//)
  assert.match(parsed.endpoint, new RegExp(PROJECT_ID))
  // Credentials must be stripped from the wire URL.
  assert.equal(parsed.endpoint.includes(TOKEN), false)
})

// ── parseDSN: backwards compat (legacy HMAC) ────────────────────────────────

test("parseDSN: legacy DSN keeps authMode=hmac", () => {
  const dsn = `https://${LEGACY_SECRET}@app.inariwatch.com/capture/${PROJECT_ID}`
  const parsed = parseDSN(dsn)
  assert.equal(parsed.secretKey, LEGACY_SECRET)
  assert.equal(parsed.authMode, "hmac")
  assert.equal(parsed.isLocal, false)
})

test("parseDSN: localhost stays local", () => {
  const parsed = parseDSN("http://localhost:9111/ingest")
  assert.equal(parsed.isLocal, true)
  assert.equal(parsed.authMode, "local")
})

// ── parseToken ──────────────────────────────────────────────────────────────

test("parseToken: returns a wire-ready ParsedDSN for valid token + projectId", () => {
  const parsed = parseToken(TOKEN, PROJECT_ID, "https://app.inariwatch.com")
  assert.ok(parsed)
  assert.equal(parsed.authMode, "token")
  assert.equal(parsed.secretKey, TOKEN)
  assert.equal(parsed.endpoint, `https://app.inariwatch.com/api/webhooks/capture/${PROJECT_ID}`)
  assert.equal(parsed.isLocal, false)
})

test("parseToken: returns null for non-token plaintext", () => {
  assert.equal(parseToken("notatoken", PROJECT_ID), null)
})

test("parseToken: returns null when projectId is not a UUID", () => {
  // Suppress the warn-on-bad-projectId line so the test output stays clean.
  const origWarn = console.warn
  console.warn = () => {}
  try {
    assert.equal(parseToken(TOKEN, "not-a-uuid"), null)
    assert.equal(parseToken(TOKEN, ""), null)
  } finally {
    console.warn = origWarn
  }
})

test("parseToken: respects host override", () => {
  const parsed = parseToken(TOKEN, PROJECT_ID, "https://staging.example.com/")
  assert.ok(parsed)
  // Trailing slash on host is normalized.
  assert.equal(parsed.endpoint, `https://staging.example.com/api/webhooks/capture/${PROJECT_ID}`)
})

// ── Transport: token mode sends Bearer, no HMAC ─────────────────────────────

test("createTransport: token mode sends Authorization: Bearer and omits x-capture-signature", async () => {
  const calls = makeFetchSpy()
  try {
    const parsed = parseToken(TOKEN, PROJECT_ID, "https://app.inariwatch.com")
    assert.ok(parsed)
    const transport = createTransport({ silent: true }, parsed)
    transport.send({
      fingerprint: "fp-1",
      title: "test",
      body: "test",
      severity: "info",
      timestamp: new Date().toISOString(),
    })
    await transport.flush()
    assert.equal(calls.length, 1)
    const headers = calls[0].init.headers
    assert.equal(headers["Authorization"], `Bearer ${TOKEN}`)
    assert.equal(headers["x-capture-signature"], undefined)
    // Body still POSTed as JSON.
    assert.equal(headers["Content-Type"], "application/json")
    const url = String(calls[0].url)
    assert.match(url, new RegExp(`/api/webhooks/capture/${PROJECT_ID}$`))
  } finally {
    restoreFetch()
  }
})

// ── Transport: legacy DSN keeps HMAC sig ────────────────────────────────────

test("createTransport: legacy DSN signs body with x-capture-signature and no Authorization", async () => {
  const calls = makeFetchSpy()
  try {
    const dsn = `https://${LEGACY_SECRET}@app.inariwatch.com/capture/${PROJECT_ID}`
    const parsed = parseDSN(dsn)
    const transport = createTransport({ silent: true }, parsed)
    transport.send({
      fingerprint: "fp-2",
      title: "test",
      body: "test",
      severity: "info",
      timestamp: new Date().toISOString(),
    })
    await transport.flush()
    assert.equal(calls.length, 1)
    const headers = calls[0].init.headers
    assert.equal(headers["Authorization"], undefined)
    assert.match(headers["x-capture-signature"] ?? "", /^sha256=[0-9a-f]{64}$/)
    assert.equal(headers["Content-Type"], "application/json")
  } finally {
    restoreFetch()
  }
})
