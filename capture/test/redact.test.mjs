/**
 * In-process PII / secret redactor tests (v0.3 S6).
 *
 * Covers every default pattern, the sensitive-key whole-value scrub,
 * Luhn validation for credit cards, hash mode, allowlist override,
 * recursion safety, cycle protection, and the perf budget (<5ms p95
 * for a 5KB payload).
 *
 * Uses Node's built-in test runner so the SDK stays zero-dep.
 *   npm test  (from capture/)
 */

import test from "node:test"
import assert from "node:assert/strict"

import { redactPayload, resolveRedactConfig } from "../dist/redact/index.js"
import { isLuhnValid } from "../dist/redact/luhn.js"
import { fnv1a32 } from "../dist/redact/hash.js"

// ── resolveRedactConfig (config coercion) ────────────────────────────────

test("resolveRedactConfig: true → enabled", () => {
  assert.deepEqual(resolveRedactConfig(true), { enabled: true })
})

test("resolveRedactConfig: false → disabled", () => {
  assert.deepEqual(resolveRedactConfig(false), { enabled: false })
})

test("resolveRedactConfig: undefined → disabled", () => {
  assert.deepEqual(resolveRedactConfig(undefined), { enabled: false })
})

test("resolveRedactConfig: object → enabled with options", () => {
  const cfg = resolveRedactConfig({ allowlist: ["a.b"], hashMode: true })
  assert.equal(cfg.enabled, true)
  assert.deepEqual(cfg.allowlist, ["a.b"])
  assert.equal(cfg.hashMode, true)
})

test("redactPayload with enabled:false short-circuits", () => {
  const input = { email: "a@b.com" }
  const out = redactPayload(input, { enabled: false })
  assert.equal(out, input) // identity, not a copy
})

// ── Email ────────────────────────────────────────────────────────────────

test("EMAIL: simple address in string", () => {
  const out = redactPayload({ msg: "from foo@bar.com" }, { enabled: true })
  assert.match(out.msg, /\[REDACTED_EMAIL\]/)
  assert.doesNotMatch(out.msg, /foo@bar\.com/)
})

test("EMAIL: plus-tag and subdomain", () => {
  const out = redactPayload(
    { msg: "ping name+tag@mail.example.co.uk now" },
    { enabled: true },
  )
  assert.match(out.msg, /\[REDACTED_EMAIL\]/)
  assert.doesNotMatch(out.msg, /name\+tag/)
})

test("EMAIL: multiple in same string both scrubbed", () => {
  const out = redactPayload(
    { msg: "a@b.com and c@d.org" },
    { enabled: true },
  )
  const matches = out.msg.match(/\[REDACTED_EMAIL\]/g)
  assert.equal(matches?.length, 2)
})

test("EMAIL: not an email is left alone", () => {
  const out = redactPayload({ msg: "hello world @ symbol" }, { enabled: true })
  assert.match(out.msg, /hello world @ symbol/)
})

// ── Phone ────────────────────────────────────────────────────────────────

test("PHONE: US format with parens", () => {
  const out = redactPayload({ msg: "call (415) 555-1234 today" }, { enabled: true })
  assert.match(out.msg, /\[REDACTED_PHONE\]/)
})

test("PHONE: dash separated", () => {
  const out = redactPayload({ msg: "415-555-1234" }, { enabled: true })
  assert.match(out.msg, /\[REDACTED_PHONE\]/)
})

test("PHONE: E.164 with country code", () => {
  const out = redactPayload({ msg: "call +52 555 123 4567 now" }, { enabled: true })
  assert.match(out.msg, /\[REDACTED_PHONE\]/)
})

test("PHONE: short numeric run NOT redacted", () => {
  const out = redactPayload({ msg: "ID 12345" }, { enabled: true })
  assert.match(out.msg, /ID 12345/)
})

// ── SSN ──────────────────────────────────────────────────────────────────

test("SSN: matches dash-separated", () => {
  const out = redactPayload({ msg: "ssn=123-45-6789" }, { enabled: true })
  assert.match(out.msg, /\[REDACTED_SSN\]/)
})

test("SSN: bare 9 digits NOT redacted as SSN (false-positive guard)", () => {
  const out = redactPayload({ msg: "ID 123456789 here" }, { enabled: true })
  assert.doesNotMatch(out.msg, /\[REDACTED_SSN\]/)
})

// ── Credit Card + Luhn ───────────────────────────────────────────────────

test("isLuhnValid: known good Visa", () => {
  assert.equal(isLuhnValid("4111111111111111"), true)
})

test("isLuhnValid: known good Mastercard", () => {
  assert.equal(isLuhnValid("5500000000000004"), true)
})

test("isLuhnValid: known good Amex (15 digits)", () => {
  assert.equal(isLuhnValid("340000000000009"), true)
})

test("isLuhnValid: rejects invalid checksum", () => {
  assert.equal(isLuhnValid("4111111111111112"), false)
})

test("isLuhnValid: rejects too-short input", () => {
  assert.equal(isLuhnValid("411111"), false)
})

test("CREDIT_CARD: redacts a Luhn-valid 16-digit number", () => {
  const out = redactPayload({ msg: "card 4111 1111 1111 1111 expires" }, { enabled: true })
  assert.match(out.msg, /\[REDACTED_CREDIT_CARD\]/)
  assert.doesNotMatch(out.msg, /4111 1111/)
})

test("CREDIT_CARD: leaves Luhn-invalid number alone", () => {
  const out = redactPayload({ msg: "order 1234567890123456 here" }, { enabled: true })
  assert.doesNotMatch(out.msg, /\[REDACTED_CREDIT_CARD\]/)
})

// ── JWT ──────────────────────────────────────────────────────────────────

test("JWT: redacts a 3-segment token", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
  const out = redactPayload({ token: "Bearer " + jwt }, { enabled: true })
  // The `token` key is sensitive, so the WHOLE value is redacted.
  assert.equal(out.token, "[REDACTED_VALUE]")
})

test("JWT: redacts when embedded in a non-sensitive key's string", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
  const out = redactPayload({ msg: "got " + jwt + " back" }, { enabled: true })
  assert.match(out.msg, /\[REDACTED_JWT\]/)
})

// ── AWS / Stripe / GitHub / OpenAI / Slack / Google ──────────────────────

test("AWS_ACCESS_KEY: redacts AKIA prefix", () => {
  const out = redactPayload(
    { stack: "ec2 client AKIAIOSFODNN7EXAMPLE failed" },
    { enabled: true },
  )
  assert.match(out.stack, /\[REDACTED_AWS_ACCESS_KEY\]/)
})

test("STRIPE_KEY: redacts sk_test_* and sk_live_*", () => {
  const out = redactPayload(
    { msg: "sk_live_abcdefghijklmnopqrstuvwx and sk_test_zyxwvutsrqponmlkjihgfed" },
    { enabled: true },
  )
  const m = out.msg.match(/\[REDACTED_STRIPE_KEY\]/g)
  assert.equal(m?.length, 2)
})

test("GITHUB_TOKEN: redacts gho_/ghp_/ghs_/ghu_/ghr_", () => {
  const tok = "ghp_" + "a".repeat(40)
  const out = redactPayload({ msg: "Authorization: Bearer " + tok }, { enabled: true })
  assert.match(out.msg, /\[REDACTED_GITHUB_TOKEN\]/)
})

test("OPENAI_KEY: redacts sk- prefix", () => {
  const k = "sk-proj-" + "X".repeat(40)
  const out = redactPayload({ msg: "OpenAI key: " + k }, { enabled: true })
  assert.match(out.msg, /\[REDACTED_OPENAI_KEY\]/)
})

test("SLACK_TOKEN: redacts xoxb-/xoxp-", () => {
  const t = "xoxb-1234567890-1234567890123-aaaaaaaaaaaaaaaaaaaaaaaa"
  const out = redactPayload({ msg: "slack=" + t }, { enabled: true })
  assert.match(out.msg, /\[REDACTED_SLACK_TOKEN\]/)
})

test("GOOGLE_API_KEY: redacts AIza prefix", () => {
  const k = "AIza" + "B".repeat(35)
  const out = redactPayload({ msg: "key=" + k }, { enabled: true })
  assert.match(out.msg, /\[REDACTED_GOOGLE_API_KEY\]/)
})

// ── Sensitive keys (whole-value scrub) ───────────────────────────────────

test("Sensitive key: password value scrubbed wholesale", () => {
  const out = redactPayload({ password: "hunter2" }, { enabled: true })
  assert.equal(out.password, "[REDACTED_VALUE]")
})

test("Sensitive key: case-insensitive (PASSWORD/Password/Pwd)", () => {
  const out = redactPayload(
    { PASSWORD: "a", Password: "b", Pwd: "c", PWD: "d" },
    { enabled: true },
  )
  assert.equal(out.PASSWORD, "[REDACTED_VALUE]")
  assert.equal(out.Password, "[REDACTED_VALUE]")
  assert.equal(out.Pwd, "[REDACTED_VALUE]")
  assert.equal(out.PWD, "[REDACTED_VALUE]")
})

test("Sensitive key: nested object value scrubbed wholesale", () => {
  const out = redactPayload(
    { user: { name: "Jesus", password: "x", api_key: "y" } },
    { enabled: true },
  )
  assert.equal(out.user.name, "Jesus")
  assert.equal(out.user.password, "[REDACTED_VALUE]")
  assert.equal(out.user.api_key, "[REDACTED_VALUE]")
})

test("Sensitive key: HTTP headers Authorization/Cookie scrubbed", () => {
  const out = redactPayload(
    {
      request: {
        method: "GET",
        url: "/api/me",
        headers: { authorization: "Bearer xyz", cookie: "sid=abc", "user-agent": "Chrome" },
      },
    },
    { enabled: true },
  )
  assert.equal(out.request.headers.authorization, "[REDACTED_VALUE]")
  assert.equal(out.request.headers.cookie, "[REDACTED_VALUE]")
  assert.equal(out.request.headers["user-agent"], "Chrome")
})

// ── Allowlist ────────────────────────────────────────────────────────────

test("Allowlist: dot-path skips redaction even if value matches", () => {
  const input = {
    request: { headers: { "user-agent": "fake-bot a@b.com test" } },
  }
  const out = redactPayload(input, {
    enabled: true,
    allowlist: ["request.headers.user-agent"],
  })
  // The string still contains the email — allowlist suppressed the scrub.
  assert.match(out.request.headers["user-agent"], /a@b\.com/)
})

test("Allowlist: array index path", () => {
  const input = { items: ["a@b.com", "c@d.com"] }
  const out = redactPayload(input, {
    enabled: true,
    allowlist: ["items[0]"],
  })
  assert.equal(out.items[0], "a@b.com")
  assert.match(out.items[1], /\[REDACTED_EMAIL\]/)
})

test("Allowlist: sensitive-key whole-value scrub also bypassed", () => {
  const input = { password: "intentionally-public-marker" }
  const out = redactPayload(input, {
    enabled: true,
    allowlist: ["password"],
  })
  assert.equal(out.password, "intentionally-public-marker")
})

// ── Hash mode ────────────────────────────────────────────────────────────

test("Hash mode: emits stable FNV suffix", () => {
  const out = redactPayload({ msg: "from a@b.com" }, { enabled: true, hashMode: true })
  const expected = `[REDACTED_EMAIL:${fnv1a32("a@b.com")}]`
  assert.match(out.msg, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
})

test("Hash mode: same value across events produces same suffix", () => {
  const a = redactPayload({ msg: "x@y.com" }, { enabled: true, hashMode: true })
  const b = redactPayload({ msg: "x@y.com elsewhere" }, { enabled: true, hashMode: true })
  const aTag = a.msg.match(/\[REDACTED_EMAIL:[a-f0-9]{8}\]/)?.[0]
  const bTag = b.msg.match(/\[REDACTED_EMAIL:[a-f0-9]{8}\]/)?.[0]
  assert.ok(aTag)
  assert.equal(aTag, bTag)
})

test("Hash mode: sensitive-key value uses [REDACTED_VALUE:hash]", () => {
  const out = redactPayload({ password: "hunter2" }, { enabled: true, hashMode: true })
  assert.match(out.password, /^\[REDACTED_VALUE:[a-f0-9]{8}\]$/)
})

// ── Optional patterns (off by default) ───────────────────────────────────

test("IPv4: NOT redacted by default", () => {
  const out = redactPayload({ msg: "from 192.168.1.5" }, { enabled: true })
  assert.match(out.msg, /192\.168\.1\.5/)
})

test("IPv4: redacted when redactIPs:true", () => {
  const out = redactPayload(
    { msg: "from 192.168.1.5" },
    { enabled: true, redactIPs: true },
  )
  assert.match(out.msg, /\[REDACTED_IP\]/)
})

test("AWS_SECRET: NOT redacted by default (false-positive risk)", () => {
  // 40-char base64-ish run that would look like an AWS secret.
  const blob = "abcd".repeat(10)
  const out = redactPayload({ msg: "secret " + blob }, { enabled: true })
  assert.match(out.msg, new RegExp(blob))
})

test("AWS_SECRET: redacted when redactAwsSecrets:true AND context says secret", () => {
  const blob = "Abc/+def" + "ghijklmnopqrstuvwx".repeat(2)
  // Ensure it's exactly 40 chars
  const exact40 = blob.slice(0, 40)
  const out = redactPayload(
    { msg: "AWS secret access key: " + exact40 },
    { enabled: true, redactAwsSecrets: true },
  )
  assert.match(out.msg, /\[REDACTED_AWS_SECRET\]/)
})

// ── _meta tagging ────────────────────────────────────────────────────────

test("_meta.redact_applied:true added on the redacted payload", () => {
  const out = redactPayload({ msg: "hello" }, { enabled: true })
  assert.equal(out._meta?.redact_applied, true)
})

test("_meta.redact_applied tagged even if nothing matched", () => {
  const out = redactPayload({ msg: "no PII here at all" }, { enabled: true })
  assert.equal(out._meta?.redact_applied, true)
})

test("_meta merges with existing _meta keys", () => {
  const out = redactPayload({ msg: "x", _meta: { existing: 1 } }, { enabled: true })
  assert.equal(out._meta.existing, 1)
  assert.equal(out._meta.redact_applied, true)
})

// ── Recursion safety ─────────────────────────────────────────────────────

test("Deep nested object: redacts at depth without overflow", () => {
  let cur = { msg: "a@b.com" }
  for (let i = 0; i < 30; i++) cur = { nested: cur }
  const out = redactPayload(cur, { enabled: true })
  // Walk down to the bottom and assert the email got scrubbed.
  let n = out
  for (let i = 0; i < 30; i++) n = n.nested
  assert.match(n.msg, /\[REDACTED_EMAIL\]/)
})

test("maxDepth: stops walking past the limit (value passes through)", () => {
  let cur = { msg: "a@b.com" }
  for (let i = 0; i < 5; i++) cur = { nested: cur }
  const out = redactPayload(cur, { enabled: true, maxDepth: 2 })
  // Past depth 2 the inner string should still contain the email.
  let n = out
  for (let i = 0; i < 5; i++) n = n.nested
  assert.match(n.msg, /a@b\.com/)
})

test("Cycle protection: object referencing itself is replaced with marker", () => {
  const a = { msg: "from a@b.com" }
  a.self = a
  const out = redactPayload(a, { enabled: true })
  assert.equal(out.self, "[REDACTED_CYCLE]")
  // Top-level email still scrubbed.
  assert.match(out.msg, /\[REDACTED_EMAIL\]/)
})

// ── Custom patterns ──────────────────────────────────────────────────────

test("customPatterns: appended pattern catches project-specific shape", () => {
  const out = redactPayload(
    { msg: "employee EMP-12345 logged in" },
    {
      enabled: true,
      customPatterns: [{ label: "EMPLOYEE_ID", regex: /EMP-\d{5,}/g }],
    },
  )
  assert.match(out.msg, /\[REDACTED_EMPLOYEE_ID\]/)
})

// ── Non-mutation ─────────────────────────────────────────────────────────

test("Input payload is not mutated", () => {
  const input = { msg: "from a@b.com", password: "x", nested: { ip: "1.2.3.4" } }
  const before = JSON.stringify(input)
  redactPayload(input, { enabled: true, redactIPs: true })
  assert.equal(JSON.stringify(input), before)
})

// ── Integration: full-shape ErrorEvent snapshot ──────────────────────────

test("Full ErrorEvent: redacts across body, headers, breadcrumbs, request body", () => {
  const event = {
    fingerprint: "abc",
    title: "TypeError: Cannot read properties of undefined",
    body: "TypeError... at handler (file.ts:1:1) — user a@b.com sent SSN 123-45-6789",
    severity: "critical",
    timestamp: "2026-05-02T00:00:00Z",
    request: {
      method: "POST",
      url: "/api/users",
      headers: {
        authorization: "Bearer abc.def.ghi",
        "content-type": "application/json",
      },
      body: { email: "user@example.com", password: "x", card: "4111 1111 1111 1111" },
    },
    breadcrumbs: [
      { category: "fetch", message: "GET /api/me from 192.168.1.5", level: "info", timestamp: "..." },
      { category: "console", message: "user x@y.com signed in", level: "info", timestamp: "..." },
    ],
    user: { id: "u_123", role: "admin" },
  }
  const out = redactPayload(event, { enabled: true })
  assert.match(out.body, /\[REDACTED_EMAIL\]/)
  assert.match(out.body, /\[REDACTED_SSN\]/)
  assert.equal(out.request.headers.authorization, "[REDACTED_VALUE]")
  assert.match(out.request.body.email, /\[REDACTED_EMAIL\]/)
  assert.equal(out.request.body.password, "[REDACTED_VALUE]")
  assert.match(out.request.body.card, /\[REDACTED_CREDIT_CARD\]/)
  assert.match(out.breadcrumbs[1].message, /\[REDACTED_EMAIL\]/)
  // IP not redacted (default off).
  assert.match(out.breadcrumbs[0].message, /192\.168\.1\.5/)
  assert.equal(out._meta.redact_applied, true)
})

// ── Performance budget ───────────────────────────────────────────────────

test("Performance: <5ms p95 over 100 runs of a 5KB payload", () => {
  // Build a representative ~5KB ErrorEvent. Stack frames + request +
  // breadcrumbs + user + tags. Mix of clean strings and scattered PII.
  const event = {
    fingerprint: "abc123",
    title: "ReferenceError: x is not defined",
    body: Array.from({ length: 25 }, (_, i) =>
      `    at fn${i} (file${i}.ts:${i * 10}:5)`
    ).join("\n"),
    severity: "critical",
    timestamp: "2026-05-02T00:00:00Z",
    environment: "production",
    release: "v1.2.3",
    request: {
      method: "POST",
      url: "/api/checkout",
      headers: {
        authorization: "Bearer xyz",
        "content-type": "application/json",
        "user-agent": "Mozilla/5.0 (compatible; chrome) — contact: ops@example.com",
      },
      body: {
        email: "buyer@example.com",
        phone: "(415) 555-1234",
        card: "4111 1111 1111 1111",
        plan: "pro",
      },
    },
    breadcrumbs: Array.from({ length: 20 }, (_, i) => ({
      timestamp: "2026-05-02T00:00:00Z",
      category: "fetch",
      message: `GET /api/route${i} → 200 (id=user_${i})`,
      level: "info",
    })),
    user: { id: "u_42", role: "admin" },
    tags: { feature: "checkout", region: "us-east" },
    metadata: {
      sessionId: "sess_abcdef",
      replaySessionId: "rep_xyz",
      extras: Array.from({ length: 30 }, (_, i) => `field_${i}=value_${i}`).join(","),
    },
  }
  const sizeBytes = Buffer.byteLength(JSON.stringify(event))
  // Sanity-check the test fixture is about right; informational only.
  assert.ok(sizeBytes >= 3000, `payload was only ${sizeBytes} bytes`)

  // Warm-up (let v8 inline the regex code paths).
  for (let i = 0; i < 10; i++) redactPayload(event, { enabled: true })

  const samples = []
  for (let i = 0; i < 100; i++) {
    const t0 = process.hrtime.bigint()
    redactPayload(event, { enabled: true })
    const t1 = process.hrtime.bigint()
    samples.push(Number(t1 - t0) / 1e6) // ms
  }
  samples.sort((a, b) => a - b)
  const p50 = samples[Math.floor(samples.length * 0.5)]
  const p95 = samples[Math.floor(samples.length * 0.95)]
  // Informational log so the perf number is captured in CI output.
  console.log(`    perf: payload=${sizeBytes}B  p50=${p50.toFixed(3)}ms  p95=${p95.toFixed(3)}ms`)
  assert.ok(p95 < 5, `p95=${p95}ms exceeds 5ms budget`)
})
