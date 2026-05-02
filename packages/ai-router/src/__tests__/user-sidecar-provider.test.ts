// v0.3 S2 — user-sidecar provider tests.
//
// These tests pin the contract between dispatch.ts and the relay-backed
// provider WITHOUT going through the dispatch fallback machinery (S1's
// rules.ts has no rule with primary=user-sidecar + cloud fallback yet —
// the first such rule lands in v0.3 S3 for notify.compose.email).
//
// Coverage:
// 1. Success path — complete() POSTs to relay /dispatch with the expected
//    shape, returns the sidecar body, captures the user-signed receipt.
// 2. Auth — Authorization header carries RELAY_DISPATCH_SECRET, and the
//    cloud apiKey NEVER crosses the relay (architecture §4.5).
// 3. Error mapping — relay 503 / 504 / network drop / missing user
//    each surface as Error.message containing one of:
//      "sidecar-offline" | "sidecar-timeout" | "sidecar-disconnect"
//    These are the patterns dispatch.ts → shouldFallback() looks for.
// 4. tool-use + vision modes throw "sidecar-offline" (not supported by
//    sidecar in v0.3 — code.* tasks stay cloud per architecture §5.1).
//
// The Go relay's own integration tests (services/relay/*_test.go) cover
// the WS protocol + dispatch routing end-to-end. The dispatch-core
// fallback path is covered indirectly by S1's existing dispatch.test.ts
// + by the S3 work that flips real rules.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setActiveSidecarUser,
  setRelayConfigOverride,
  takeLastUserSidecarReceipt,
  complete,
  withTools,
  vision,
} from "../providers/user-sidecar";

// ── Test harness: mock fetch + relay config ────────────────────────────

interface RelayCall {
  url: string;
  body: any;
  bearer: string | null;
}

function mockRelay(impl: (call: RelayCall) => Response | Promise<Response>): {
  spy: ReturnType<typeof vi.fn>;
  calls: RelayCall[];
} {
  const calls: RelayCall[] = [];
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    let body: any = null;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null;
    } catch {
      body = init?.body;
    }
    const headers = (init?.headers as Record<string, string>) || {};
    const bearerHeader =
      headers["authorization"] ?? headers["Authorization"] ?? null;
    const bearer = bearerHeader ? bearerHeader.replace(/^Bearer\s+/i, "") : null;
    const call: RelayCall = { url, body, bearer };
    calls.push(call);
    return impl(call);
  });
  return { spy, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const TEST_RELAY_URL = "https://relay.test.example";
const TEST_DISPATCH_SECRET = "test-secret-32";

const MINIMAL_OPTS = {
  apiKey: "sk-cloud-key-must-not-leak",
  systemPrompt: "you are inari",
  messages: [{ role: "user" as const, content: "hi" }],
};

describe("user-sidecar provider — happy path + relay shape", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    setRelayConfigOverride({
      baseUrl: TEST_RELAY_URL,
      dispatchSecret: TEST_DISPATCH_SECRET,
    });
    setActiveSidecarUser("user-success");
    takeLastUserSidecarReceipt();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setRelayConfigOverride(null);
    setActiveSidecarUser(null);
  });

  it("POSTs to relay /dispatch with user_id + Authorization bearer", async () => {
    const { spy, calls } = mockRelay(() =>
      jsonResponse(200, {
        request_id: "rid-1",
        userId: "user-success",
        task: "user-sidecar/complete",
        status: "ok",
        body: { stub: true, task: "user-sidecar/complete", note: "ok" },
        receipt: { kind: "user-sidecar", sig: "ed25519-fake" },
      }),
    );
    globalThis.fetch = spy;

    const res = await complete(MINIMAL_OPTS);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(calls[0].url).toBe(`${TEST_RELAY_URL}/dispatch`);
    expect(calls[0].body.user_id).toBe("user-success");
    expect(calls[0].body.task).toBe("user-sidecar/complete");
    expect(calls[0].bearer).toBe(TEST_DISPATCH_SECRET);
    // The cloud apiKey MUST NOT travel to the relay (architecture §4.5).
    expect(JSON.stringify(calls[0].body)).not.toContain("sk-cloud-key-must-not-leak");
    expect(res.text).toBe("ok");
    expect(res.model).toBe("user-sidecar-stub");

    const receipt = takeLastUserSidecarReceipt();
    expect(receipt).toMatchObject({ kind: "user-sidecar", sig: "ed25519-fake" });
  });

  it("strips apiKey from outbound payload (only Authorization carries the relay secret)", async () => {
    const { spy, calls } = mockRelay(() =>
      jsonResponse(200, {
        request_id: "x",
        status: "ok",
        body: { stub: true, note: "ok" },
      }),
    );
    globalThis.fetch = spy;
    await complete(MINIMAL_OPTS);
    const stringified = JSON.stringify(calls[0]);
    expect(stringified).not.toContain("sk-cloud-key-must-not-leak");
    expect(calls[0].bearer).toBe(TEST_DISPATCH_SECRET);
  });

  it("forwards systemPrompt + messages + temperature into the relay payload", async () => {
    const { spy, calls } = mockRelay(() =>
      jsonResponse(200, {
        status: "ok",
        body: { stub: true, note: "ok" },
      }),
    );
    globalThis.fetch = spy;
    await complete({
      ...MINIMAL_OPTS,
      temperature: 0.7,
      maxTokens: 512,
      model: "llama-3.2-3b-q4",
    });
    const payload = calls[0].body.payload;
    expect(payload.kind).toBe("complete");
    expect(payload.systemPrompt).toBe("you are inari");
    expect(payload.temperature).toBe(0.7);
    expect(payload.maxTokens).toBe(512);
    expect(payload.model).toBe("llama-3.2-3b-q4");
    expect(payload.messages[0].content).toBe("hi");
  });
});

describe("user-sidecar provider — error mapping for fallback contract", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    setRelayConfigOverride({
      baseUrl: TEST_RELAY_URL,
      dispatchSecret: TEST_DISPATCH_SECRET,
    });
    setActiveSidecarUser("user-error");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setRelayConfigOverride(null);
    setActiveSidecarUser(null);
  });

  it("maps relay 503 sidecar-offline → 'sidecar-offline' Error", async () => {
    globalThis.fetch = mockRelay(() =>
      jsonResponse(503, { status: "error", error: "sidecar-offline" }),
    ).spy;
    await expect(complete(MINIMAL_OPTS)).rejects.toThrow(/sidecar-offline/);
  });

  it("maps relay 503 sidecar-disconnect → 'sidecar-disconnect' Error", async () => {
    globalThis.fetch = mockRelay(() =>
      jsonResponse(503, { status: "error", error: "sidecar-disconnect" }),
    ).spy;
    await expect(complete(MINIMAL_OPTS)).rejects.toThrow(/sidecar-disconnect/);
  });

  it("maps relay 504 → 'sidecar-timeout' Error", async () => {
    globalThis.fetch = mockRelay(() =>
      jsonResponse(504, { status: "error", error: "sidecar-timeout" }),
    ).spy;
    await expect(complete(MINIMAL_OPTS)).rejects.toThrow(/sidecar-timeout/);
  });

  it("maps relay 401 (bad RELAY_DISPATCH_SECRET) → 'sidecar-offline' so the router falls back to cloud", async () => {
    globalThis.fetch = mockRelay(() =>
      jsonResponse(401, { error: "bad-dispatch-bearer" }),
    ).spy;
    await expect(complete(MINIMAL_OPTS)).rejects.toThrow(/sidecar-offline/);
  });

  it("retries once on transient network failure, then surfaces 'sidecar-offline'", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      throw new Error("ECONNRESET");
    });
    await expect(complete(MINIMAL_OPTS)).rejects.toThrow(/sidecar-offline/);
    expect(calls).toBe(2);
  });

  it("requires an active user_id — throws 'sidecar-offline' when missing", async () => {
    setActiveSidecarUser(null);
    const spy = vi.fn(async () => jsonResponse(200, { status: "ok", body: {} }));
    globalThis.fetch = spy;
    await expect(complete(MINIMAL_OPTS)).rejects.toThrow(/sidecar-offline/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws 'sidecar-offline' when relay config is missing AND no override", async () => {
    setRelayConfigOverride(null);
    // Make sure env vars aren't accidentally set in the test runner.
    const before = {
      url: process.env.RELAY_URL,
      sec: process.env.RELAY_DISPATCH_SECRET,
    };
    delete process.env.RELAY_URL;
    delete process.env.RELAY_DISPATCH_SECRET;
    try {
      await expect(complete(MINIMAL_OPTS)).rejects.toThrow(/sidecar-offline/);
    } finally {
      if (before.url) process.env.RELAY_URL = before.url;
      if (before.sec) process.env.RELAY_DISPATCH_SECRET = before.sec;
    }
  });
});

describe("user-sidecar provider — unsupported modes", () => {
  beforeEach(() => {
    setRelayConfigOverride({
      baseUrl: TEST_RELAY_URL,
      dispatchSecret: TEST_DISPATCH_SECRET,
    });
    setActiveSidecarUser("user-x");
  });
  afterEach(() => {
    setRelayConfigOverride(null);
    setActiveSidecarUser(null);
  });

  it("withTools throws 'sidecar-offline' — code.* tasks are cloud-only", async () => {
    await expect(
      withTools({
        ...MINIMAL_OPTS,
        tools: [
          { name: "x", description: "x", input_schema: { type: "object" } },
        ],
      }),
    ).rejects.toThrow(/sidecar-offline/);
  });

  it("vision throws 'sidecar-offline' — vision is cloud-only in v0.3", async () => {
    await expect(
      vision({
        apiKey: "k",
        systemPrompt: "s",
        message: { role: "user", text: "x", imageBase64: "abc" },
      }),
    ).rejects.toThrow(/sidecar-offline/);
  });
});

describe("user-sidecar provider — receipt drainage", () => {
  beforeEach(() => {
    setRelayConfigOverride({
      baseUrl: TEST_RELAY_URL,
      dispatchSecret: TEST_DISPATCH_SECRET,
    });
    setActiveSidecarUser("user-r");
    takeLastUserSidecarReceipt();
  });
  afterEach(() => {
    setRelayConfigOverride(null);
    setActiveSidecarUser(null);
  });

  it("captures receipt then clears it on take", async () => {
    globalThis.fetch = mockRelay(() =>
      jsonResponse(200, {
        status: "ok",
        body: { stub: true, note: "ok" },
        receipt: { sig: "abc" },
      }),
    ).spy;
    await complete(MINIMAL_OPTS);
    expect(takeLastUserSidecarReceipt()).toEqual({ sig: "abc" });
    // Second take returns null — receipt drained.
    expect(takeLastUserSidecarReceipt()).toBeNull();
  });
});
