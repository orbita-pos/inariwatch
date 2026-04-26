import { test } from "node:test";
import assert from "node:assert/strict";

import {
  init,
  captureException,
  captureMessage,
  captureLog,
  resetForTesting,
  setTransportForTesting,
  flush,
} from "../dist/client.js";

class Recording {
  constructor() {
    this.events = [];
  }
  send(ev) {
    this.events.push(ev);
  }
  async flush() {}
}

function fresh(extra = {}) {
  resetForTesting();
  init({ silent: true, environment: "test", disableAutoInstrument: true, ...extra });
  const r = new Recording();
  setTransportForTesting(r);
  return r;
}

test("captures runtime + fingerprint", async () => {
  const r = fresh();
  await captureException(new Error("boom"));
  assert.equal(r.events.length, 1);
  const ev = r.events[0];
  assert.equal(ev.runtime, "browser");
  assert.equal(ev.eventType, "error");
  assert.equal(ev.fingerprint.length, 64);
  assert.ok(ev.title.includes("boom"));
});

test("captureMessage records severity", async () => {
  const r = fresh();
  await captureMessage("disk almost full", "warning");
  assert.equal(r.events[0].severity, "warning");
});

test("captureLog records eventType=log + metadata", async () => {
  const r = fresh();
  await captureLog("retry exhausted", "error", { attempt: 3 });
  assert.equal(r.events[0].eventType, "log");
  assert.equal(r.events[0].metadata.attempt, 3);
});

test("beforeSend can drop event", async () => {
  resetForTesting();
  const r = new Recording();
  init({ silent: true, disableAutoInstrument: true, beforeSend: () => null });
  setTransportForTesting(r);
  await captureException(new Error("nope"));
  assert.equal(r.events.length, 0);
});

test("uninitialized capture is a no-op", async () => {
  resetForTesting();
  await captureException(new Error("ignored")); // must not throw
});

test("flush is awaitable on uninitialized", async () => {
  resetForTesting();
  await flush(); // must not throw
});
