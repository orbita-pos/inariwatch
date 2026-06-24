/**
 * Fase 4 — ci-webhook helper tests.
 *
 * Adversarial coverage:
 *   - Flag defaults to off
 *   - Channel + key derivation is deterministic + stable
 *   - Register / publish / wait all return graceful "unavailable" when
 *     Redis is down (the availability SLA this module promises)
 *   - Wait returns "fired" when a publish lands, "timeout" when none does
 *   - Malformed publish payloads don't terminate the subscriber; it keeps
 *     listening until a valid publish or timeout
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

// ── Module under test — import AFTER mocks so the client factory resolves
//    against the mocked getIoredisClient.

const mockGetIoredisClient = vi.fn();

vi.mock("@/lib/redis", () => ({
  getIoredisClient: (...args: unknown[]) => mockGetIoredisClient(...args),
}));

import {
  isCiWebhookEnabled,
  shaMapKey,
  sessionChannel,
  registerCiSession,
  unregisterCiSession,
  waitForCiWebhook,
  publishCiCompletion,
} from "../ci-webhook";

// ── A controllable fake ioredis implementing the subset we exercise ───────

interface FakeIoredisLike {
  set: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  duplicate: () => FakeIoredisLike;
  on: (event: string, handler: (...a: unknown[]) => void) => FakeIoredisLike;
  emit: (event: string, ...args: unknown[]) => void;
}

function makeFake(overrides: Partial<FakeIoredisLike> = {}): FakeIoredisLike {
  const emitter = new EventEmitter();
  const self: FakeIoredisLike = {
    set: vi.fn().mockResolvedValue("OK"),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
    publish: vi.fn().mockResolvedValue(1),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue("OK"),
    duplicate: () => makeFake(), // Each duplicate is independent by default.
    on: (event: string, handler: (...a: unknown[]) => void) => {
      emitter.on(event, handler);
      return self;
    },
    emit: (event: string, ...args: unknown[]) => emitter.emit(event, ...args),
    ...overrides,
  };
  return self;
}

// Helper: create a "parent" fake whose duplicate() returns a specific child
// so the test can inject messages via child.emit("message", ...).
function fakeWithController(child: FakeIoredisLike): FakeIoredisLike {
  const parent = makeFake({ duplicate: () => child });
  return parent;
}

beforeEach(() => {
  mockGetIoredisClient.mockReset();
  delete process.env.CI_WEBHOOK_MODE;
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Flag gating ───────────────────────────────────────────────────────────

describe("isCiWebhookEnabled", () => {
  it("returns false when unset", () => {
    expect(isCiWebhookEnabled()).toBe(false);
  });

  it("returns false when set to something other than literal 'true'", () => {
    process.env.CI_WEBHOOK_MODE = "1";
    expect(isCiWebhookEnabled()).toBe(false);
    process.env.CI_WEBHOOK_MODE = "yes";
    expect(isCiWebhookEnabled()).toBe(false);
    process.env.CI_WEBHOOK_MODE = "false";
    expect(isCiWebhookEnabled()).toBe(false);
  });

  it("returns true for literal 'true'", () => {
    process.env.CI_WEBHOOK_MODE = "true";
    expect(isCiWebhookEnabled()).toBe(true);
  });
});

// ── Channel / key helpers ─────────────────────────────────────────────────

describe("key helpers", () => {
  it("shaMapKey is deterministic and includes the sha", () => {
    expect(shaMapKey("abc123")).toBe("ci:sha:abc123");
  });

  it("sessionChannel is deterministic and includes the session id", () => {
    expect(sessionChannel("sess-42")).toBe("remediation:sess-42:ci");
  });
});

// ── registerCiSession ─────────────────────────────────────────────────────

describe("registerCiSession", () => {
  it("returns false when Redis is unavailable", async () => {
    mockGetIoredisClient.mockReturnValue(null);
    const ok = await registerCiSession("sess-1", "sha-1");
    expect(ok).toBe(false);
  });

  it("SETs with EX TTL on the canonical key and returns true on success", async () => {
    const client = makeFake();
    mockGetIoredisClient.mockReturnValue(client);
    const ok = await registerCiSession("sess-1", "sha-abc");
    expect(ok).toBe(true);
    expect(client.set).toHaveBeenCalledWith("ci:sha:sha-abc", "sess-1", "EX", 20 * 60);
  });

  it("returns false when the SET throws (Redis error)", async () => {
    const client = makeFake({
      set: vi.fn().mockRejectedValue(new Error("connection lost")),
    });
    mockGetIoredisClient.mockReturnValue(client);
    const ok = await registerCiSession("sess-1", "sha-abc");
    expect(ok).toBe(false);
  });
});

// ── unregisterCiSession ───────────────────────────────────────────────────

describe("unregisterCiSession", () => {
  it("no-ops when Redis unavailable", async () => {
    mockGetIoredisClient.mockReturnValue(null);
    await expect(unregisterCiSession("sha-1")).resolves.toBeUndefined();
  });

  it("DELs the canonical key", async () => {
    const client = makeFake();
    mockGetIoredisClient.mockReturnValue(client);
    await unregisterCiSession("sha-xyz");
    expect(client.del).toHaveBeenCalledWith("ci:sha:sha-xyz");
  });

  it("swallows DEL errors (non-fatal cleanup)", async () => {
    const client = makeFake({
      del: vi.fn().mockRejectedValue(new Error("boom")),
    });
    mockGetIoredisClient.mockReturnValue(client);
    await expect(unregisterCiSession("sha-1")).resolves.toBeUndefined();
  });
});

// ── publishCiCompletion ───────────────────────────────────────────────────

describe("publishCiCompletion", () => {
  it("returns null when Redis unavailable", async () => {
    mockGetIoredisClient.mockReturnValue(null);
    const result = await publishCiCompletion("sha-1", { conclusion: "success", deliveryId: null, checkRunId: null });
    expect(result).toBeNull();
  });

  it("returns null when no session is registered for the sha", async () => {
    const client = makeFake({ get: vi.fn().mockResolvedValue(null) });
    mockGetIoredisClient.mockReturnValue(client);
    const result = await publishCiCompletion("sha-1", { conclusion: "success", deliveryId: null, checkRunId: null });
    expect(result).toBeNull();
    expect(client.publish).not.toHaveBeenCalled();
  });

  it("publishes to the session channel with the full payload", async () => {
    const client = makeFake({
      get: vi.fn().mockResolvedValue("sess-42"),
      publish: vi.fn().mockResolvedValue(3),
    });
    mockGetIoredisClient.mockReturnValue(client);
    const result = await publishCiCompletion("sha-xyz", {
      conclusion: "failure",
      deliveryId: "delivery-99",
      checkRunId: 12345,
    });
    expect(result).toEqual({ sessionId: "sess-42", subscribers: 3 });

    const [channel, raw] = client.publish.mock.calls[0];
    expect(channel).toBe("remediation:sess-42:ci");
    const parsed = JSON.parse(raw as string);
    expect(parsed.conclusion).toBe("failure");
    expect(parsed.deliveryId).toBe("delivery-99");
    expect(parsed.checkRunId).toBe(12345);
    expect(parsed.headSha).toBe("sha-xyz");
    expect(typeof parsed.receivedAt).toBe("number");
  });
});

// ── waitForCiWebhook ──────────────────────────────────────────────────────

describe("waitForCiWebhook", () => {
  it("returns 'unavailable' when Redis is down", async () => {
    mockGetIoredisClient.mockReturnValue(null);
    const result = await waitForCiWebhook("sess-1", 100);
    expect(result).toEqual({ result: "unavailable" });
  });

  it("returns 'fired' with the decoded payload on a valid publish", async () => {
    const subscriber = makeFake();
    mockGetIoredisClient.mockReturnValue(fakeWithController(subscriber));

    const waitPromise = waitForCiWebhook("sess-1", 5_000);
    // Wait one microtask so the subscribe() call registers the listener.
    await new Promise((r) => setImmediate(r));

    subscriber.emit(
      "message",
      "remediation:sess-1:ci",
      JSON.stringify({
        conclusion: "success",
        headSha: "sha-abc",
        deliveryId: "del-1",
        checkRunId: 1,
        receivedAt: Date.now(),
      }),
    );

    const result = await waitPromise;
    expect(result.result).toBe("fired");
    if (result.result !== "fired") return;
    expect(result.payload.conclusion).toBe("success");
    expect(subscriber.unsubscribe).toHaveBeenCalledWith("remediation:sess-1:ci");
    expect(subscriber.quit).toHaveBeenCalled();
  });

  it("ignores messages on other channels", async () => {
    const subscriber = makeFake();
    mockGetIoredisClient.mockReturnValue(fakeWithController(subscriber));

    const waitPromise = waitForCiWebhook("sess-1", 200);
    await new Promise((r) => setImmediate(r));

    subscriber.emit(
      "message",
      "remediation:sess-999:ci", // different session
      JSON.stringify({ conclusion: "success" }),
    );

    const result = await waitPromise;
    expect(result.result).toBe("timeout");
  });

  it("ignores malformed publishes and keeps waiting", async () => {
    const subscriber = makeFake();
    mockGetIoredisClient.mockReturnValue(fakeWithController(subscriber));

    const waitPromise = waitForCiWebhook("sess-1", 200);
    await new Promise((r) => setImmediate(r));

    // Non-JSON — subscriber should swallow silently
    subscriber.emit("message", "remediation:sess-1:ci", "<not json>");
    // Valid JSON, but missing the required 'conclusion' field — also swallowed
    subscriber.emit("message", "remediation:sess-1:ci", JSON.stringify({ headSha: "x" }));

    const result = await waitPromise;
    expect(result.result).toBe("timeout");
  });

  it("returns 'timeout' when no publish arrives in window", async () => {
    const subscriber = makeFake();
    mockGetIoredisClient.mockReturnValue(fakeWithController(subscriber));

    const result = await waitForCiWebhook("sess-1", 50);
    expect(result.result).toBe("timeout");
    expect(subscriber.unsubscribe).toHaveBeenCalled();
    expect(subscriber.quit).toHaveBeenCalled();
  });

  it("returns 'unavailable' when the subscribe call throws", async () => {
    const subscriber = makeFake({
      subscribe: vi.fn().mockRejectedValue(new Error("socket closed")),
    });
    mockGetIoredisClient.mockReturnValue(fakeWithController(subscriber));
    const result = await waitForCiWebhook("sess-1", 5_000);
    expect(result.result).toBe("unavailable");
  });
});
