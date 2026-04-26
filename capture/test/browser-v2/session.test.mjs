import { test } from "node:test";
import assert from "node:assert/strict";

import { ensureSessionId, getSessionId, resetSessionIdForTesting } from "../dist/session.js";

test("ensureSessionId produces a uuid-shaped id", () => {
  resetSessionIdForTesting();
  const id = ensureSessionId();
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(getSessionId(), id);
});

test("ensureSessionId is stable within process", () => {
  resetSessionIdForTesting();
  const a = ensureSessionId();
  const b = ensureSessionId();
  assert.equal(a, b);
});

test("override wins on first call", () => {
  resetSessionIdForTesting();
  const id = ensureSessionId("forced-id-123");
  assert.equal(id, "forced-id-123");
});
