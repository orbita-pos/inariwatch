/**
 * Fase 3 — worker http-agent: mirror of the web-side test. Same behavior
 * contract, worker-side implementation.
 */

import { describe, it, afterEach, after, before } from "node:test";
import assert from "node:assert/strict";
import { getGlobalDispatcher, setGlobalDispatcher, Agent } from "undici";
import {
  installKeepAliveDispatcher,
  isModelRoutingEnabled,
  resetForTests,
} from "../http-agent.js";

const ORIGINAL_FLAG = process.env.REMEDIATION_MODEL_ROUTING;
let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;

before(() => {
  originalDispatcher = getGlobalDispatcher();
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) {
    delete process.env.REMEDIATION_MODEL_ROUTING;
  } else {
    process.env.REMEDIATION_MODEL_ROUTING = ORIGINAL_FLAG;
  }
  resetForTests();
});

after(() => {
  // Restore the dispatcher that was active when the suite loaded so
  // subsequent test files (pool.test.ts, etc.) get the default back.
  const current = getGlobalDispatcher();
  if (current !== originalDispatcher) {
    setGlobalDispatcher(originalDispatcher);
    (current as unknown as { close?: () => Promise<void> }).close?.();
  }
});

describe("isModelRoutingEnabled (worker)", () => {
  it("returns true only for the literal 'true'", () => {
    process.env.REMEDIATION_MODEL_ROUTING = "true";
    assert.equal(isModelRoutingEnabled(), true);
  });

  it("returns false for 'false'", () => {
    process.env.REMEDIATION_MODEL_ROUTING = "false";
    assert.equal(isModelRoutingEnabled(), false);
  });

  it("returns false when unset", () => {
    delete process.env.REMEDIATION_MODEL_ROUTING;
    assert.equal(isModelRoutingEnabled(), false);
  });
});

describe("installKeepAliveDispatcher (worker)", () => {
  it("no-op when flag is off", () => {
    delete process.env.REMEDIATION_MODEL_ROUTING;
    resetForTests();
    const before = getGlobalDispatcher();
    installKeepAliveDispatcher();
    const after = getGlobalDispatcher();
    assert.equal(after, before);
  });

  it("installs an Agent when flag is on", () => {
    process.env.REMEDIATION_MODEL_ROUTING = "true";
    resetForTests();
    installKeepAliveDispatcher();
    const d = getGlobalDispatcher();
    assert.ok(d instanceof Agent, "global dispatcher should be an Agent");
  });

  it("is idempotent", () => {
    process.env.REMEDIATION_MODEL_ROUTING = "true";
    resetForTests();
    installKeepAliveDispatcher();
    const first = getGlobalDispatcher();
    installKeepAliveDispatcher();
    const second = getGlobalDispatcher();
    assert.equal(second, first);
  });
});
