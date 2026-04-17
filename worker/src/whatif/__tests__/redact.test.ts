/**
 * Tests for the server-side substrate event redactor. Covers each
 * specific attack surface the audit flagged: HTTP auth headers, cookie
 * headers, DB query params that carry tokens.
 *
 * Run: cd worker && npx tsx --test src/whatif/__tests__/redact.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { redactEvents } from "../redact.js";

test("redactEvents: undefined input returns undefined", () => {
  assert.equal(redactEvents(undefined), undefined);
});

test("redactEvents: empty array passes through", () => {
  assert.deepEqual(redactEvents([]), []);
});

test("redactEvents: scrubs Authorization header (http_request)", () => {
  const events = [{
    seq: 1, timestamp_ns: 0,
    kind: {
      type: "http_request",
      method: "POST",
      url: "https://api.stripe.com/v1/charges",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer sk_live_supersecret",
      },
    },
  }];
  const out = redactEvents(events)!;
  assert.equal((out[0].kind.headers as Record<string, string>).authorization, "***");
  // Non-sensitive header preserved
  assert.equal((out[0].kind.headers as Record<string, string>)["content-type"], "application/json");
});

test("redactEvents: scrubs Cookie + Set-Cookie both directions", () => {
  const events = [
    {
      seq: 1, timestamp_ns: 0,
      kind: { type: "http_request", headers: { cookie: "session=abc123" } },
    },
    {
      seq: 2, timestamp_ns: 1,
      kind: { type: "http_response", headers: { "set-cookie": "sid=xyz; HttpOnly" } },
    },
  ];
  const out = redactEvents(events)!;
  assert.equal((out[0].kind.headers as Record<string, string>).cookie, "***");
  assert.equal((out[1].kind.headers as Record<string, string>)["set-cookie"], "***");
});

test("redactEvents: scrubs x-api-key and x-auth-token variants", () => {
  const events = [{
    seq: 1, timestamp_ns: 0,
    kind: {
      type: "http_request",
      headers: {
        "x-api-key": "sk_test_abc",
        "X-Auth-Token": "bearer_xyz",  // case insensitive match
        "x-csrf-token": "csrf_value",
      },
    },
  }];
  const out = redactEvents(events)!;
  const h = out[0].kind.headers as Record<string, string>;
  assert.equal(h["x-api-key"], "***");
  assert.equal(h["X-Auth-Token"], "***");
  assert.equal(h["x-csrf-token"], "***");
});

test("redactEvents: case-insensitive header name matching", () => {
  const events = [{
    seq: 1, timestamp_ns: 0,
    kind: {
      type: "http_request",
      headers: { Authorization: "Bearer x", AUTHORIZATION: "y", authorization: "z" },
    },
  }];
  const out = redactEvents(events)!;
  const h = out[0].kind.headers as Record<string, string>;
  assert.equal(h.Authorization, "***");
  assert.equal(h.AUTHORIZATION, "***");
  assert.equal(h.authorization, "***");
});

test("redactEvents: scrubs DB query params that look like tokens", () => {
  const events = [{
    seq: 1, timestamp_ns: 0,
    kind: {
      type: "db_query",
      system: "postgres",
      query: "SELECT * FROM api_keys WHERE token = $1",
      params: ["github_pat_12345678901234567890abcdefghij"],
    },
  }];
  const out = redactEvents(events)!;
  assert.deepEqual(out[0].kind.params, ["***"]);
});

test("redactEvents: scrubs JWT-shaped DB params", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature_here_long_enough";
  const events = [{
    seq: 1, timestamp_ns: 0,
    kind: { type: "db_query", query: "SELECT ...", params: [jwt, "normal-value", 42] },
  }];
  const out = redactEvents(events)!;
  assert.deepEqual(out[0].kind.params, ["***", "normal-value", 42]);
});

test("redactEvents: preserves short / non-token DB params", () => {
  const events = [{
    seq: 1, timestamp_ns: 0,
    kind: {
      type: "db_query",
      query: "SELECT * FROM users WHERE id = $1 AND email = $2",
      params: [42, "user@example.com"],
    },
  }];
  const out = redactEvents(events)!;
  assert.deepEqual(out[0].kind.params, [42, "user@example.com"]);
});

test("redactEvents: non-HTTP/DB events pass through unchanged", () => {
  const events = [
    { seq: 1, timestamp_ns: 0, kind: { type: "time_now", ms: 12345 } },
    { seq: 2, timestamp_ns: 1, kind: { type: "random_float", value: 0.5 } },
    { seq: 3, timestamp_ns: 2, kind: { type: "process_exit", code: 0 } },
  ];
  const out = redactEvents(events)!;
  assert.deepEqual(out, events);
  // Reference-preserved when nothing changes — cheaper downstream work.
  for (let i = 0; i < events.length; i++) assert.equal(out[i], events[i]);
});

test("redactEvents: event with no kind passes through", () => {
  // Defensive — shouldn't happen in real output but tolerated.
  const events = [{ seq: 1, timestamp_ns: 0 }] as Array<{ seq: number; timestamp_ns: number; kind?: Record<string, unknown> }>;
  const out = redactEvents(events)!;
  assert.deepEqual(out, events);
});

test("redactEvents: returns NEW array, doesn't mutate input", () => {
  const original = [{
    seq: 1, timestamp_ns: 0,
    kind: { type: "http_request", headers: { authorization: "Bearer secret" } },
  }];
  const out = redactEvents(original)!;
  // Input unchanged
  assert.equal((original[0].kind.headers as Record<string, string>).authorization, "Bearer secret");
  // Output redacted
  assert.equal((out[0].kind.headers as Record<string, string>).authorization, "***");
  // Different references when modified
  assert.notEqual(out[0], original[0]);
});
