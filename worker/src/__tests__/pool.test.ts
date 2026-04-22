/**
 * Tests for worker/src/pool.ts — Fase 2b pool client.
 *
 * Uses Node's built-in test runner via tsx. Run with: npm test.
 *
 * Network is mocked by reassigning globalThis.fetch for the duration
 * of each test; no real HTTP. Env flags are saved/restored per test so
 * the suite is order-independent.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isPoolEnabled,
  tryPoolCheckout,
  returnPoolContainer,
  sandboxModeFor,
} from "../pool.js";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = process.env.CONTAINER_POOL_ENABLED;

function withEnabled() {
  process.env.CONTAINER_POOL_ENABLED = "true";
}
function withDisabled() {
  process.env.CONTAINER_POOL_ENABLED = "false";
}

function restoreEnv() {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.CONTAINER_POOL_ENABLED;
  } else {
    process.env.CONTAINER_POOL_ENABLED = ORIGINAL_ENV;
  }
}

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function installFetchSpy(
  respond: (call: FetchCall) => Response | Promise<Response>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const hdr = init?.headers as Record<string, string> | undefined;
    if (hdr) for (const [k, v] of Object.entries(hdr)) headers[k] = v;
    const bodyStr = typeof init?.body === "string" ? init.body : null;
    const body = bodyStr ? JSON.parse(bodyStr) : null;
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      body,
      headers,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  restoreEnv();
});

// ── isPoolEnabled ───────────────────────────────────────────────────────────

describe("isPoolEnabled", () => {
  it("returns true only for the literal string 'true'", () => {
    process.env.CONTAINER_POOL_ENABLED = "true";
    assert.equal(isPoolEnabled(), true);
  });

  it("returns false for 'false'", () => {
    process.env.CONTAINER_POOL_ENABLED = "false";
    assert.equal(isPoolEnabled(), false);
  });

  it("returns false for unset", () => {
    delete process.env.CONTAINER_POOL_ENABLED;
    assert.equal(isPoolEnabled(), false);
  });

  it("returns false for truthy-but-non-canonical values", () => {
    for (const v of ["1", "yes", "TRUE", "True", " true ", "on"]) {
      process.env.CONTAINER_POOL_ENABLED = v;
      assert.equal(isPoolEnabled(), false, `expected false for ${JSON.stringify(v)}`);
    }
  });
});

// ── tryPoolCheckout ─────────────────────────────────────────────────────────

describe("tryPoolCheckout", () => {
  beforeEach(() => {
    withEnabled();
  });

  it("returns null without hitting the network when pool is disabled", async () => {
    withDisabled();
    const calls = installFetchSpy(() => new Response("should-not-be-called", { status: 500 }));
    const result = await tryPoolCheckout({
      projectId: "p1",
      goServer: "http://localhost:9400",
      secret: "s",
    });
    assert.equal(result, null);
    assert.equal(calls.length, 0);
  });

  it("returns null without hitting the network when projectId is missing", async () => {
    const calls = installFetchSpy(() => new Response("", { status: 200 }));
    const result = await tryPoolCheckout({
      projectId: null,
      goServer: "http://localhost:9400",
      secret: "s",
    });
    assert.equal(result, null);
    assert.equal(calls.length, 0);
  });

  it("returns a PoolCheckoutResult on 200 with valid body", async () => {
    installFetchSpy(() =>
      new Response(
        JSON.stringify({
          container_id: "pool-abcd1234-dead",
          workspace: "/workspace/repo",
          source: "pool",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const result = await tryPoolCheckout({
      projectId: "p1",
      goServer: "http://localhost:9400",
      secret: "s",
    });
    assert.deepEqual(result, {
      containerId: "pool-abcd1234-dead",
      workspace: "/workspace/repo",
      source: "pool",
    });
  });

  it("returns null on 404 (empty pool) — callers fall back to cold spawn", async () => {
    installFetchSpy(() =>
      new Response(JSON.stringify({ error: "no warm container for project" }), {
        status: 404,
      }),
    );
    const result = await tryPoolCheckout({
      projectId: "p1",
      goServer: "http://localhost:9400",
      secret: "s",
    });
    assert.equal(result, null);
  });

  it("returns null on any non-2xx (e.g. 500) — pool failure never breaks remediation", async () => {
    installFetchSpy(() => new Response("upstream broken", { status: 500 }));
    const result = await tryPoolCheckout({
      projectId: "p1",
      goServer: "http://localhost:9400",
      secret: "s",
    });
    assert.equal(result, null);
  });

  it("returns null when the response body is missing required fields", async () => {
    installFetchSpy(() =>
      new Response(JSON.stringify({ container_id: "x" /* no workspace */ }), {
        status: 200,
      }),
    );
    const result = await tryPoolCheckout({
      projectId: "p1",
      goServer: "http://localhost:9400",
      secret: "s",
    });
    assert.equal(result, null);
  });

  it("returns null when fetch throws (network error)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("econnrefused");
    }) as typeof fetch;
    const result = await tryPoolCheckout({
      projectId: "p1",
      goServer: "http://localhost:9400",
      secret: "s",
    });
    assert.equal(result, null);
  });

  it("sends Bearer auth + JSON body with project_id", async () => {
    const calls = installFetchSpy(
      () =>
        new Response(
          JSON.stringify({ container_id: "c", workspace: "/w", source: "pool" }),
          { status: 200 },
        ),
    );
    await tryPoolCheckout({
      projectId: "p-123",
      goServer: "https://api.staging.inariwatch.com",
      secret: "s3cr3t",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.staging.inariwatch.com/pool/checkout");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers.Authorization, "Bearer s3cr3t");
    assert.deepEqual(calls[0]!.body, { project_id: "p-123" });
  });
});

// ── returnPoolContainer ─────────────────────────────────────────────────────

describe("returnPoolContainer", () => {
  it("sends health_status='healthy' when healthy=true", async () => {
    const calls = installFetchSpy(() => new Response("{}", { status: 200 }));
    await returnPoolContainer({
      containerId: "c1",
      healthy: true,
      goServer: "http://localhost:9400",
      secret: "s",
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.body, { container_id: "c1", health_status: "healthy" });
  });

  it("sends health_status='unhealthy' when healthy=false", async () => {
    const calls = installFetchSpy(() => new Response("{}", { status: 200 }));
    await returnPoolContainer({
      containerId: "c1",
      healthy: false,
      goServer: "http://localhost:9400",
      secret: "s",
    });
    assert.deepEqual(calls[0]!.body, { container_id: "c1", health_status: "unhealthy" });
  });

  it("swallows errors so a failed return never propagates into the job", async () => {
    globalThis.fetch = (async () => {
      throw new Error("econnrefused");
    }) as typeof fetch;
    // Must NOT throw
    await returnPoolContainer({
      containerId: "c1",
      healthy: true,
      goServer: "http://localhost:9400",
      secret: "s",
    });
  });
});

// ── sandboxModeFor ──────────────────────────────────────────────────────────

describe("sandboxModeFor", () => {
  it("returns null when pool is disabled, regardless of source", () => {
    withDisabled();
    assert.equal(sandboxModeFor("pool"), null);
    assert.equal(sandboxModeFor("cold"), null);
    assert.equal(sandboxModeFor(null), null);
  });

  it("returns 'pool-warm' for source=pool when enabled", () => {
    withEnabled();
    assert.equal(sandboxModeFor("pool"), "pool-warm");
  });

  it("returns 'pool-cold-fallback' for source=cold when enabled", () => {
    withEnabled();
    assert.equal(sandboxModeFor("cold"), "pool-cold-fallback");
  });

  it("returns 'pool-cold-fallback' for source=null when enabled (defensive default)", () => {
    withEnabled();
    assert.equal(sandboxModeFor(null), "pool-cold-fallback");
  });
});
