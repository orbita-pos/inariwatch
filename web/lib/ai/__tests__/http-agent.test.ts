/**
 * Fase 3 — http-agent: installs the undici keep-alive dispatcher only
 * when REMEDIATION_MODEL_ROUTING is on, and only once per process.
 *
 * We verify the flag behavior by mutating process.env and observing the
 * global dispatcher. We do NOT issue real HTTP; we just read `getGlobalDispatcher`
 * back and assert identity (agent instance vs default).
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGlobalDispatcher, setGlobalDispatcher, Agent } from "undici";
import {
  installKeepAliveDispatcher,
  isModelRoutingEnabled,
  resetForTests,
} from "../http-agent";

const ORIGINAL_FLAG = process.env.REMEDIATION_MODEL_ROUTING;
const ORIGINAL_DISPATCHER = getGlobalDispatcher();

beforeEach(() => {
  resetForTests();
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) {
    delete process.env.REMEDIATION_MODEL_ROUTING;
  } else {
    process.env.REMEDIATION_MODEL_ROUTING = ORIGINAL_FLAG;
  }
  resetForTests();
});

afterAll(() => {
  // Dispose whatever Agent was installed by the "flag on" test and restore
  // the dispatcher that was active when this suite loaded. Leaking an Agent
  // across tests in the same worker keeps TLS sockets open and trips the
  // Vitest teardown watchdog.
  const current = getGlobalDispatcher();
  if (current !== ORIGINAL_DISPATCHER) {
    setGlobalDispatcher(ORIGINAL_DISPATCHER);
    (current as unknown as { close?: () => Promise<void> }).close?.();
  }
});

describe("isModelRoutingEnabled", () => {
  it("is true only for the literal 'true' string", () => {
    process.env.REMEDIATION_MODEL_ROUTING = "true";
    expect(isModelRoutingEnabled()).toBe(true);
  });

  it("is false for 'false'", () => {
    process.env.REMEDIATION_MODEL_ROUTING = "false";
    expect(isModelRoutingEnabled()).toBe(false);
  });

  it("is false when unset", () => {
    delete process.env.REMEDIATION_MODEL_ROUTING;
    expect(isModelRoutingEnabled()).toBe(false);
  });

  it("is false for truthy-but-not-'true' values", () => {
    process.env.REMEDIATION_MODEL_ROUTING = "1";
    expect(isModelRoutingEnabled()).toBe(false);
    process.env.REMEDIATION_MODEL_ROUTING = "TRUE";
    expect(isModelRoutingEnabled()).toBe(false);
  });
});

describe("installKeepAliveDispatcher", () => {
  it("is a no-op when the flag is off", () => {
    delete process.env.REMEDIATION_MODEL_ROUTING;
    const before = getGlobalDispatcher();
    installKeepAliveDispatcher();
    const after = getGlobalDispatcher();
    expect(after).toBe(before);
  });

  it("installs an Agent when the flag is on", () => {
    process.env.REMEDIATION_MODEL_ROUTING = "true";
    installKeepAliveDispatcher();
    const d = getGlobalDispatcher();
    expect(d).toBeInstanceOf(Agent);
    // restore
    (ORIGINAL_DISPATCHER as unknown as { close?: () => void }).close?.();
  });

  it("is idempotent — installs at most once", () => {
    process.env.REMEDIATION_MODEL_ROUTING = "true";
    installKeepAliveDispatcher();
    const first = getGlobalDispatcher();
    installKeepAliveDispatcher();
    const second = getGlobalDispatcher();
    expect(second).toBe(first);
  });
});
